"""Quarantine: a damaged manifest is named with exit 9, moved aside, and the listing is clean again.

Runs after every workload suite, so each workload has a manifest to damage, and before
`test_80_keys`, which verifies an Outlook snapshot. Contacts and calendar skip when their suites
did not run.

Quarantine is not side-effect free: it deletes the original, writes `_quarantine/<key>`, takes and
releases the owner's lease, and for contacts and calendar deletes the mailbox's delta cursor. So
every case lists the bucket's versions first and afterwards removes each version and delete marker
written since, by version id. That returns the original manifest, the summary index and the cursor
with their original version ids, and each case asserts the bucket lists exactly what it did before.

A listing answers from the owner's snapshot summary index and decrypts only manifests the index
has no row for, so damage to a manifest that has a row is invisible to it. Each case therefore also
removes the index, the state a bucket is in when its data predates the index, which makes the
listing decrypt every manifest of the owner.
"""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import leases, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.quarantine import (
    CASES,
    QUARANTINE_PREFIX,
    QuarantineCase,
    bucket_versions,
    damaged,
    roll_back_to,
    versioning_enabled,
)
from atlas_e2e.scrub import scrub

EXIT_NOT_FOUND = 7
EXIT_CONTENT_UNREADABLE = 9


@pytest.fixture(scope="module", autouse=True)
def _requires_a_versioned_bucket(settings: Settings, s3: Any) -> None:
    """The rollback removes versions by id, so an unversioned bucket would lose a manifest."""
    assert versioning_enabled(s3, settings.bucket), "the tenant bucket is not versioned"


def _sole_owner(s3: Any, settings: Settings, workload: str) -> str:
    owners = storage.owner_segments(s3, settings.bucket, workload)
    assert len(owners) == 1, f"expected one backed-up {workload} owner, found {len(owners)}"
    return owners[0]


def test_01_a_healthy_manifest_is_not_quarantined(cli: Cli, settings: Settings, s3: Any) -> None:
    """A manifest that decrypts is refused with exit 7 and stays where it is.

    Exit 7 also means "nothing stored at that key", so the message is the only thing that tells
    the two refusals apart; `reads cleanly` is the phrase the service puts in it.
    """
    owner = _sole_owner(s3, settings, "outlook")
    snapshot = storage.snapshot_ids(s3, settings.bucket, owner)[0]
    key = f"manifests/{owner}/{snapshot}.json"

    result = cli.run("outlook", "quarantine", "--key", key)

    assert result.code == EXIT_NOT_FOUND, result.describe()
    assert "reads cleanly" in result.out, result.describe()
    assert leases.object_exists(s3, settings.bucket, key), "a healthy manifest was moved"
    assert not leases.object_exists(s3, settings.bucket, f"{QUARANTINE_PREFIX}{key}")


@pytest.mark.parametrize("case", CASES, ids=[case.workload for case in CASES])
def test_02_a_damaged_manifest_is_named_then_quarantined(
    cli: Cli, settings: Settings, s3: Any, case: QuarantineCase
) -> None:
    """The listing exits 9 naming the key, quarantine moves it, and the listing exits 0 again.

    The key is matched in the output because only the output names it; it is compared scrubbed,
    as the output is, and inside the `quarantine` command the CLI prints for it.
    """
    if not case.configured(settings):
        pytest.skip(f"{case.workload} is not configured for this run")
    owners = storage.owner_segments(s3, settings.bucket, case.workload)
    if not owners and case.workload in {"contacts", "calendar"}:
        pytest.skip(f"no {case.workload} snapshot in the bucket; its suite did not run")
    owner = _sole_owner(s3, settings, case.workload)
    snapshots = storage.snapshot_ids(s3, settings.bucket, owner, case.workload)
    key = f"{storage.MANIFEST_PREFIXES[case.workload]}{owner}/{snapshots[0]}.json"
    moved_to = f"{QUARANTINE_PREFIX}{key}"
    assert not leases.object_exists(s3, settings.bucket, moved_to), f"{moved_to} already exists"

    original = leases.read_object(s3, settings.bucket, key)
    before = bucket_versions(s3, settings.bucket)
    try:
        s3.put_object(Bucket=settings.bucket, Key=key, Body=damaged(original))
        s3.delete_object(Bucket=settings.bucket, Key=case.summary_key(owner))

        listing = cli.run(*case.list_args(settings))
        assert listing.code == EXIT_CONTENT_UNREADABLE, listing.describe()
        hint = scrub(f"atlas {case.workload} quarantine --key {key}", settings)
        assert hint in listing.out, listing.describe()

        cli.ok(case.workload, "quarantine", "--key", key)
        assert not leases.object_exists(s3, settings.bucket, key), "the original is still listed"
        assert leases.read_object(s3, settings.bucket, moved_to) == damaged(original), (
            "the quarantined copy is not the damaged bytes, unchanged"
        )

        cli.ok(*case.list_args(settings))
    finally:
        lost = roll_back_to(s3, settings.bucket, before)

    assert lost == [], f"the run removed versions a rollback cannot restore: {lost}"
    assert bucket_versions(s3, settings.bucket) == before, "the bucket was not rolled back"
    assert leases.read_object(s3, settings.bucket, key) == original
    assert storage.snapshot_ids(s3, settings.bucket, owner, case.workload) == snapshots
