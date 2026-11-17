"""Run leases: one operation per mailbox, and tenant commands that exclude owner commands.

Each case writes the lease another run would hold straight into the bucket, then runs one command.
Racing two real commands would leave the outcome to timing. Exit 12 is `ATLAS_OWNER_BUSY`.

Depends on `test_10_outlook`: the mailbox must hold at least two snapshots, so the snapshot every
delete below targets is never the newest. Were the lease ever ignored, that delete is refused with
exit 11 instead of erasing a snapshot `test_80_keys` still reads. Every lease written here is
removed by version id, and the last test proves none is left for the suites that follow.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Any

import pytest

from atlas_e2e import leases, probe, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph

EXIT_PARTIAL = 2
EXIT_FORMAT_UNSUPPORTED = 9
EXIT_SNAPSHOT_NOT_NEWEST = 11
EXIT_OWNER_BUSY = 12
DEK_KEY = "_meta/dek.enc"

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _mailbox_with_two_snapshots(settings: Settings, s3: Any) -> None:
    """Reads the mailbox's owner segment and its oldest snapshot from the bucket."""
    owners = storage.owner_segments(s3, settings.bucket, "outlook")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    owner = owners[0]
    snapshots = leases.manifests_oldest_first(s3, settings.bucket, f"manifests/{owner}/")
    assert len(snapshots) >= 2, "these cases need a mailbox snapshot that is not the newest"
    STATE.update(owner=owner, oldest=snapshots[0], lease_key=leases.outlook_lease_key(owner))


def _hold_mailbox(
    s3: Any, settings: Settings, run_marker: str, body: bytes | None = None
) -> AbstractContextManager[None]:
    """A live backup lease on the mailbox, held by a run that is not the CLI under test."""
    body = body or leases.lease_body(f"{run_marker}-foreign", "backup", leases.LIVE)
    return leases.foreign_lease(s3, settings.bucket, STATE["lease_key"], body)


def _snapshots(s3: Any, settings: Settings) -> list[str]:
    return sorted(storage.snapshot_ids(s3, settings.bucket, STATE["owner"]))


def test_01_backup_is_refused_while_another_run_holds_the_mailbox(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A backup exits 12, writes no snapshot, and leaves the holder's lease as it found it."""
    before = _snapshots(s3, settings)
    body = leases.lease_body(f"{run_marker}-foreign", "backup", leases.LIVE)
    with _hold_mailbox(s3, settings, run_marker, body):
        result = cli.run("outlook", "backup", "-m", settings.mailbox, "-f", run_marker)
        assert result.code == EXIT_OWNER_BUSY, result.describe()
        assert leases.read_object(s3, settings.bucket, STATE["lease_key"]) == body, (
            "the refused backup changed the lease another run holds"
        )
    assert _snapshots(s3, settings) == before, "a refused backup wrote a snapshot"


def test_02_restore_is_refused_while_another_run_holds_the_mailbox(
    cli: Cli, graph: Graph, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A restore takes the source mailbox's lease too, so it exits 12 and creates no folder."""
    roots_before = len(probe.restore_roots_containing(graph, settings.mailbox, run_marker))
    with _hold_mailbox(s3, settings, run_marker):
        result = cli.run("outlook", "restore", "-s", STATE["oldest"])
    assert result.code == EXIT_OWNER_BUSY, result.describe()
    roots_after = len(probe.restore_roots_containing(graph, settings.mailbox, run_marker))
    assert roots_after == roots_before, "a refused restore created a Restore-* folder"


def test_03_delete_and_quarantine_are_refused_while_another_run_holds_the_mailbox(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A snapshot delete and a quarantine of the mailbox both exit 12 and move nothing."""
    owner, oldest = STATE["owner"], STATE["oldest"]
    manifest = f"manifests/{owner}/{oldest}.json"
    before = _snapshots(s3, settings)
    with _hold_mailbox(s3, settings, run_marker):
        deleted = cli.run("outlook", "delete", "-s", oldest, "-y")
        quarantined = cli.run("outlook", "quarantine", "--key", manifest)
    assert deleted.code == EXIT_OWNER_BUSY, deleted.describe()
    assert quarantined.code == EXIT_OWNER_BUSY, quarantined.describe()
    assert _snapshots(s3, settings) == before, "a refused delete or quarantine removed a snapshot"
    assert not leases.object_exists(s3, settings.bucket, f"_quarantine/{manifest}")


@pytest.mark.parametrize("state", ["expired", "released", "damaged"])
def test_04_a_lease_nobody_holds_is_taken_over(
    cli: Cli, settings: Settings, s3: Any, run_marker: str, state: str
) -> None:
    """An expired, released or unparseable lease blocks nothing, and the taker releases it.

    The command is the same snapshot delete as above, which needs the lease before it checks the
    snapshot order. Exit 11 therefore proves the run got past the lease, and the snapshot is not the
    newest, so nothing is deleted. The key being empty afterwards proves the run replaced the
    stale lease with its own and then gave that back.
    """
    holder = f"{run_marker}-foreign"
    body = {
        "expired": leases.lease_body(holder, "backup", leases.EXPIRED),
        "released": leases.lease_body(holder, "backup", leases.LIVE, released=True),
        "damaged": b"{not a lease",
    }[state]
    before = _snapshots(s3, settings)
    with _hold_mailbox(s3, settings, run_marker, body):
        result = cli.run("outlook", "delete", "-s", STATE["oldest"], "-y")
        assert result.code == EXIT_SNAPSHOT_NOT_NEWEST, result.describe()
        assert not leases.object_exists(s3, settings.bucket, STATE["lease_key"]), (
            f"the {state} lease was not taken over and released"
        )
    assert _snapshots(s3, settings) == before


def test_05_a_lease_from_a_newer_atlas_is_never_taken_over(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A lease in a format this build cannot read is refused with exit 9, not replaced.

    Treating it as damage would take the mailbox over from a newer Atlas that is still running.
    """
    body = leases.lease_body(f"{run_marker}-foreign", "backup", leases.LIVE, format_version=2)
    with _hold_mailbox(s3, settings, run_marker, body):
        result = cli.run("outlook", "delete", "-s", STATE["oldest"], "-y")
        assert result.code == EXIT_FORMAT_UNSUPPORTED, result.describe()
        assert leases.read_object(s3, settings.bucket, STATE["lease_key"]) == body


def test_06_rewrap_skips_the_tenant_while_a_mailbox_is_leased(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`keys rewrap` reports the tenant busy, exits 2, and writes no new data key wrapper.

    A bare re-wrap always writes a new version of the wrapped key when it runs, so an unchanged
    version list is the proof that it did not. It gives its own tenant lease back as well.
    """
    wrappers = storage.object_version_ids(s3, settings.bucket, DEK_KEY)
    assert wrappers, "the bucket holds no data key"
    with _hold_mailbox(s3, settings, run_marker):
        result = cli.run("keys", "rewrap")
    assert result.code == EXIT_PARTIAL, result.describe()
    assert storage.object_version_ids(s3, settings.bucket, DEK_KEY) == wrappers, (
        "the re-wrap wrote a wrapper while a mailbox was leased"
    )
    assert not leases.object_exists(s3, settings.bucket, leases.TENANT_LEASE_KEY)


def test_07_backup_is_refused_while_a_tenant_command_holds_the_tenant(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """With a re-wrap holding the tenant, a backup exits 12, writes no snapshot, keeps no lease."""
    body = leases.lease_body(f"{run_marker}-foreign", "rewrap", leases.LIVE)
    before = _snapshots(s3, settings)
    with leases.foreign_lease(s3, settings.bucket, leases.TENANT_LEASE_KEY, body):
        result = cli.run("outlook", "backup", "-m", settings.mailbox, "-f", run_marker)
    assert result.code == EXIT_OWNER_BUSY, result.describe()
    assert _snapshots(s3, settings) == before, "a refused backup wrote a snapshot"
    assert not leases.object_exists(s3, settings.bucket, STATE["lease_key"]), (
        "the refused backup left its own mailbox lease behind"
    )


def test_08_no_lease_is_left_behind(settings: Settings, s3: Any) -> None:
    """Nothing in the bucket still holds an owner or the tenant, so later suites run unblocked."""
    assert leases.stored_lease_keys(s3, settings.bucket) == []
