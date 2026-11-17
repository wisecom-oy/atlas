"""Calendar lifecycle: seed, back up, verify, destroy in M365, restore, prove it came back.

The suite works in a calendar of its own, named after the run marker, so the sweep can delete it
whole and nothing lands in the mailbox's default calendar. The events have no attendees: creating,
deleting and restoring them sends no invitation to anyone.

A calendar backup has no scope, so it reads every calendar of the mailbox. An event elsewhere in
that mailbox with an attachment Atlas cannot capture makes the run exit 2, which this suite
reports as a failure. The test mailbox's own calendars are expected to stay empty.
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
def _requires_calendar_access(graph: Graph, settings: Settings) -> None:
    """Skips the module when the app cannot read calendars; preflight names the missing grant."""
    try:
        graph.get(f"/users/{settings.mailbox}/calendars", **{"$top": 1, "$select": "id"})
    except GraphError as err:
        pytest.skip(f"Calendars.ReadWrite not granted to the E2E app: {err}")


def test_01_seed_a_calendar_and_an_event(graph: Graph, settings: Settings, run_marker: str) -> None:
    """Creates this run's calendar with one event that carries a file attachment."""
    calendar_id = people.create_calendar(graph, settings.mailbox, run_marker)
    STATE["calendar_id"] = calendar_id
    STATE["first"] = people.create_event(graph, settings.mailbox, calendar_id, run_marker, 1)

    assert _subjects(graph, settings) == [STATE["first"].subject]


def test_02_backup_writes_a_snapshot(cli: Cli, settings: Settings, s3: Any) -> None:
    """The first run stores the event, its attachment, and one complete manifest."""
    cli.ok("calendar", "backup", "-m", settings.mailbox)

    owners = storage.owner_segments(s3, settings.bucket, "calendar")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    STATE["owner"] = owners[0]

    snapshots = storage.snapshot_ids(s3, settings.bucket, owners[0], "calendar")
    assert len(snapshots) == 1, f"expected one calendar snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]
    assert storage.list_keys(s3, settings.bucket, f"calendar/data/{owners[0]}/"), (
        "no event object was written"
    )
    assert storage.list_keys(s3, settings.bucket, f"calendar/attachments/{owners[0]}/"), (
        "the event's file attachment was not stored"
    )


def test_03_list_and_verify_read_the_snapshot(cli: Cli, settings: Settings) -> None:
    """`list` reads the summary index; `verify` re-hashes every object, then checks `--fast`."""
    cli.ok("calendar", "list", "-m", settings.mailbox)
    cli.ok("calendar", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"])
    cli.ok("calendar", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"], "--fast")


def test_04_a_new_event_is_stored_incrementally(
    cli: Cli, graph: Graph, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A second event adds objects and a second manifest, and removes nothing."""
    prefix = f"calendar/data/{STATE['owner']}/"
    before = set(storage.list_keys(s3, settings.bucket, prefix))

    STATE["second"] = people.create_event(
        graph, settings.mailbox, STATE["calendar_id"], run_marker, 2
    )
    cli.ok("calendar", "backup", "-m", settings.mailbox)

    after = set(storage.list_keys(s3, settings.bucket, prefix))
    assert len(after - before) == 1, f"expected one new event object, got {len(after - before)}"
    assert before <= after, "an incremental run must not remove existing objects"

    snapshots = storage.snapshot_ids(s3, settings.bucket, STATE["owner"], "calendar")
    assert len(snapshots) == 2, f"expected a second snapshot, found {snapshots}"
    STATE["newest"] = next(s for s in snapshots if s != STATE["snapshot"])


def test_05_restore_recreates_a_deleted_event(cli: Cli, graph: Graph, settings: Settings) -> None:
    """Deletes the first event from M365 and restores the newest, incremental, snapshot."""
    people.delete_event(graph, settings.mailbox, STATE["first"].event_id)
    assert STATE["first"].subject not in _subjects(graph, settings), "event survived deletion"

    cli.ok("calendar", "restore", "-m", settings.mailbox, "-s", STATE["newest"])

    restored = _events_named(graph, settings, STATE["first"].subject)
    assert len(restored) == 1, f"expected the deleted event back once, found {len(restored)}"
    STATE["restored_id"] = str(restored[0]["id"])


def test_06_the_restored_attachment_is_byte_identical(graph: Graph, settings: Settings) -> None:
    """The restored event's attachment hashes to the seeded bytes, read back through Graph."""
    digest = people.event_attachment_sha256(
        graph, settings.mailbox, STATE["restored_id"], STATE["first"].attachment_name
    )
    assert digest == STATE["first"].attachment_sha256, (
        "restored attachment does not match the seeded bytes"
    )


def test_07_a_second_restore_creates_nothing(cli: Cli, graph: Graph, settings: Settings) -> None:
    """A rerun skips the event it restored and the one that was never deleted."""
    cli.ok("calendar", "restore", "-m", settings.mailbox, "-s", STATE["newest"])

    assert _subjects(graph, settings) == sorted([STATE["first"].subject, STATE["second"].subject])


def test_08_snapshot_delete_keeps_the_other_snapshot(cli: Cli, settings: Settings, s3: Any) -> None:
    """`delete -s` drops one manifest; the remaining snapshot still verifies in full."""
    cli.ok("calendar", "delete", "-m", settings.mailbox, "-s", STATE["newest"], "-y")

    snapshots = storage.snapshot_ids(s3, settings.bucket, STATE["owner"], "calendar")
    assert snapshots == [STATE["snapshot"]], f"unexpected snapshots after the delete: {snapshots}"
    cli.ok("calendar", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"])


def _events_named(graph: Graph, settings: Settings, subject: str) -> list[dict[str, Any]]:
    """Events in this run's calendar with an exact subject."""
    return [
        e
        for e in people.events_in(graph, settings.mailbox, STATE["calendar_id"])
        if e.get("subject") == subject
    ]


def _subjects(graph: Graph, settings: Settings) -> list[str]:
    """Subjects in this run's calendar, sorted."""
    return sorted(
        str(e.get("subject", ""))
        for e in people.events_in(graph, settings.mailbox, STATE["calendar_id"])
    )
