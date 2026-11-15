"""Contacts lifecycle: seed, back up, verify, destroy in M365, restore, prove it came back.

Same shape as the Outlook suite, with two differences that come from the product. A contacts
backup has no folder scope, so it reads the whole mailbox and the assertions look only at this
run's folder. And every snapshot is complete on its own, so a second backup with one new contact
writes one new object and a second manifest, not a delta.
"""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import people, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph, GraphError

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _requires_contacts_access(graph: Graph, settings: Settings) -> None:
    """Skips the module when the app cannot read contacts; preflight names the missing grant."""
    try:
        graph.get(f"/users/{settings.mailbox}/contactFolders", **{"$top": 1, "$select": "id"})
    except GraphError as err:
        pytest.skip(f"Contacts.ReadWrite not granted to the E2E app: {err}")


def test_01_seed_a_folder_and_a_contact(graph: Graph, settings: Settings, run_marker: str) -> None:
    """Creates this run's contact folder with one contact in it."""
    folder_id = people.create_contact_folder(graph, settings.mailbox, run_marker)
    STATE["folder_id"] = folder_id
    STATE["first"] = people.create_contact(graph, settings.mailbox, folder_id, run_marker, 1)

    assert _names(graph, settings) == [STATE["first"].display_name]


def test_02_backup_writes_a_snapshot(cli: Cli, settings: Settings, s3: Any) -> None:
    """The first run stores the contact and one complete manifest."""
    cli.ok("contacts", "backup", "-m", settings.mailbox)

    owners = storage.owner_segments(s3, settings.bucket, "contacts")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    STATE["owner"] = owners[0]

    snapshots = storage.snapshot_ids(s3, settings.bucket, owners[0], "contacts")
    assert len(snapshots) == 1, f"expected one contacts snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]
    assert storage.list_keys(s3, settings.bucket, f"contacts/data/{owners[0]}/"), (
        "no contact object was written"
    )


def test_03_list_and_verify_read_the_snapshot(cli: Cli, settings: Settings) -> None:
    """`list` reads the summary index; `verify` re-hashes every object, then checks `--fast`."""
    cli.ok("contacts", "list", "-m", settings.mailbox)
    cli.ok("contacts", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"])
    cli.ok("contacts", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"], "--fast")


def test_04_an_unchanged_mailbox_writes_no_snapshot(cli: Cli, settings: Settings, s3: Any) -> None:
    """A run that finds no change resumes its sync checkpoints and stores nothing."""
    cli.ok("contacts", "backup", "-m", settings.mailbox)

    snapshots = storage.snapshot_ids(s3, settings.bucket, STATE["owner"], "contacts")
    assert snapshots == [STATE["snapshot"]], f"an unchanged run wrote a snapshot: {snapshots}"


def test_05_a_new_contact_is_stored_incrementally(
    cli: Cli, graph: Graph, settings: Settings, s3: Any, run_marker: str
) -> None:
    """One new contact costs one new object, and the new manifest still lists the first."""
    prefix = f"contacts/data/{STATE['owner']}/"
    before = set(storage.list_keys(s3, settings.bucket, prefix))

    STATE["second"] = people.create_contact(
        graph, settings.mailbox, STATE["folder_id"], run_marker, 2
    )
    cli.ok("contacts", "backup", "-m", settings.mailbox)

    after = set(storage.list_keys(s3, settings.bucket, prefix))
    assert len(after - before) == 1, f"expected one new contact object, got {len(after - before)}"
    assert before <= after, "an incremental run must not remove existing objects"

    snapshots = storage.snapshot_ids(s3, settings.bucket, STATE["owner"], "contacts")
    assert len(snapshots) == 2, f"expected a second snapshot, found {snapshots}"
    STATE["newest"] = next(s for s in snapshots if s != STATE["snapshot"])


def test_06_restore_recreates_a_deleted_contact(cli: Cli, graph: Graph, settings: Settings) -> None:
    """Deletes the first contact from M365 and restores the newest snapshot.

    The newest snapshot is the one restored, on purpose: it was written by the incremental run, so
    finding the first contact in it proves a snapshot is complete rather than a delta.
    """
    people.delete_contact(graph, settings.mailbox, STATE["first"].contact_id)
    assert STATE["first"].display_name not in _names(graph, settings), "contact survived deletion"

    cli.ok("contacts", "restore", "-m", settings.mailbox, "-s", STATE["newest"])

    restored = [
        c
        for c in people.contacts_in(graph, settings.mailbox, STATE["folder_id"])
        if c.get("displayName") == STATE["first"].display_name
    ]
    assert len(restored) == 1, f"expected the deleted contact back once, found {len(restored)}"
    addresses = [e.get("address") for e in restored[0].get("emailAddresses", [])]
    assert addresses == [STATE["first"].email], "the restored contact lost its email address"


def test_07_a_second_restore_creates_nothing(cli: Cli, graph: Graph, settings: Settings) -> None:
    """Restore only adds, and it recognises what it already restored.

    The second contact was never deleted and the first was restored a moment ago, so a rerun has
    nothing to create. Two entries after it means neither was duplicated.
    """
    cli.ok("contacts", "restore", "-m", settings.mailbox, "-s", STATE["newest"])

    assert _names(graph, settings) == sorted(
        [STATE["first"].display_name, STATE["second"].display_name]
    )


def test_08_snapshot_delete_keeps_the_other_snapshot(cli: Cli, settings: Settings, s3: Any) -> None:
    """`delete -s` drops one manifest; the remaining snapshot still verifies in full."""
    cli.ok("contacts", "delete", "-m", settings.mailbox, "-s", STATE["newest"], "-y")

    snapshots = storage.snapshot_ids(s3, settings.bucket, STATE["owner"], "contacts")
    assert snapshots == [STATE["snapshot"]], f"unexpected snapshots after the delete: {snapshots}"
    cli.ok("contacts", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"])


def _names(graph: Graph, settings: Settings) -> list[str]:
    """Display names in this run's contact folder, sorted."""
    return sorted(
        str(c.get("displayName", ""))
        for c in people.contacts_in(graph, settings.mailbox, STATE["folder_id"])
    )
