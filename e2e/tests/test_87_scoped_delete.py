"""Owner-scoped deletes and the newest Outlook snapshot delete, asserted through S3.

`test_85` deletes one drive snapshot. This module covers what no other suite runs: erasing one
mailbox's contacts and calendar backups with `-m`, deleting the newest Outlook snapshot, and the
confirmation prompt every delete shows without `-y`.

Runs after `test_85_workload_delete` and before `test_90_purge`, on the snapshots `test_10`,
`test_14` and `test_16` wrote. `outlook delete -m`, `onedrive delete -o` and `sharepoint delete
--site` without `-s` are deliberately not run: `test_90` asserts that those workloads' data
prefixes still hold objects to purge.
"""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import exits, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

POINTERS = "_meta/outlook-manifests"


def _outlook_owner(settings: Settings, s3: Any) -> str:
    """The one Outlook owner segment in the bucket."""
    owners = storage.owner_segments(s3, settings.bucket, "outlook")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    return owners[0]


def _newest_outlook_snapshot(settings: Settings, s3: Any, owner: str) -> tuple[str, list[str]]:
    """The newest Outlook snapshot id and the older ones, by manifest write order."""
    keys = exits.keys_oldest_first(s3, settings.bucket, f"manifests/{owner}/")
    assert len(keys) >= 2, f"need two Outlook snapshots, found {len(keys)}"
    ids = [exits.snapshot_id_of(key) for key in keys]
    return ids[-1], ids[:-1]


def _outside(
    entries: list[tuple[str, str, bool]], scopes: list[str]
) -> list[tuple[str, str, bool]]:
    """Version entries outside the given scopes, lease objects left out."""
    return [
        entry
        for entry in entries
        if not exits.is_lease_key(entry[0]) and not any(entry[0].startswith(s) for s in scopes)
    ]


def test_01_a_delete_without_an_answer_changes_nothing(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """Without `-y`, stdin at EOF exits 1 and an answer of `n` exits 0; neither deletes anything.

    Every handler asks before the deletion service runs and before any lease is taken, so the
    version listing, not just the key set, must be identical.
    """
    newest, _ = _newest_outlook_snapshot(settings, s3, _outlook_owner(settings, s3))
    commands: list[tuple[str, ...]] = [("outlook", "delete", "-s", newest)]
    for workload in ("contacts", "calendar"):
        if storage.owner_segments(s3, settings.bucket, workload):
            commands.append((workload, "delete", "-m", settings.mailbox))
    before = storage.version_listing(s3, settings.bucket)

    for argv in commands:
        unanswered = cli.run(*argv, stdin="")
        assert unanswered.code == exits.EXIT_FAILURE, unanswered.describe()
        declined = cli.run(*argv, stdin="n\n")
        assert declined.code == 0, declined.describe()

    assert storage.version_listing(s3, settings.bucket) == before, "an unconfirmed delete wrote"


@pytest.mark.parametrize("workload", ["contacts", "calendar"])
def test_02_a_mailbox_delete_erases_every_version(
    cli: Cli, settings: Settings, s3: Any, workload: str
) -> None:
    """`<workload> delete -m` removes every version and delete marker under the mailbox's scopes.

    A plain delete in a versioned bucket would only stack a delete marker on each key, so the
    noncurrent versions are checked as well as the current keys. Leases and summary rewrites leave
    noncurrent versions under `_meta/`, so there is something to prove. Every other workload's
    versions must be exactly as they were.
    """
    segments = storage.owner_segments(s3, settings.bucket, workload)
    if not segments:
        pytest.skip(f"no {workload} manifest in the bucket; its suite did not run")
    scopes = exits.people_scopes(workload, segments[0])
    in_scope = [v for scope in scopes for v in exits.versions_under(s3, settings.bucket, scope)]
    current = [k for scope in scopes for k in storage.list_keys(s3, settings.bucket, scope)]
    assert len(in_scope) > len(current), f"no noncurrent {workload} version to prove erasure on"
    others = _outside(storage.version_listing(s3, settings.bucket), scopes)

    cli.ok(workload, "delete", "-m", settings.mailbox, "-y")

    for scope in scopes:
        left = exits.versions_under(s3, settings.bucket, scope)
        assert left == [], f"{len(left)} version(s) survived under {scope}"
    assert _outside(storage.version_listing(s3, settings.bucket), scopes) == others, (
        f"a {workload} mailbox delete touched another workload"
    )


def test_03_the_newest_outlook_snapshot_delete_keeps_the_data(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """`outlook delete -s` on the newest snapshot removes its manifest, pointers and cursor.

    Message and attachment objects stay, because older snapshots reference the same keys. The
    summary index is rewritten without the snapshot's row rather than removed. The snapshot that is
    newest afterwards must still verify in full.
    """
    owner = _outlook_owner(settings, s3)
    newest, older = _newest_outlook_snapshot(settings, s3, owner)
    bucket = settings.bucket
    removed = [
        f"manifests/{owner}/{newest}.json",
        f"{POINTERS}/snapshots/{newest}.json",
        f"{POINTERS}/owners/{owner}/latest.json",
        f"_meta/outlook-cursors/{owner}.json",
    ]
    summary = f"{POINTERS}/owners/{owner}/summary.json"
    data_before = storage.list_keys(s3, bucket, f"data/{owner}/")
    attachments_before = storage.list_keys(s3, bucket, f"attachments/{owner}/")
    summary_before = storage.object_version_ids(s3, bucket, summary)
    assert data_before, "no Outlook data object to retain"

    cli.ok("outlook", "delete", "-s", newest, "-y")

    for key in removed:
        assert storage.object_version_ids(s3, bucket, key) == [], f"{key} survived the delete"
    assert storage.list_keys(s3, bucket, f"data/{owner}/") == data_before, "data was deleted"
    assert storage.list_keys(s3, bucket, f"attachments/{owner}/") == attachments_before
    assert summary in storage.list_keys(s3, bucket, POINTERS), "the summary index was removed"
    assert set(storage.object_version_ids(s3, bucket, summary)) > set(summary_before), (
        "the summary index was not rewritten without the deleted snapshot"
    )
    assert set(storage.snapshot_ids(s3, bucket, owner)) == set(older), "other snapshots changed"

    cli.ok("outlook", "verify", "-m", settings.mailbox, "-s", older[-1])
