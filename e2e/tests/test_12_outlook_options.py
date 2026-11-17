"""Outlook commands and options the lifecycle suite does not reach.

Runs on the snapshots `test_10_outlook` wrote, so it adds no backup of its own. Each case is one
behaviour a scheduled job depends on: a selector that matches nothing must fail instead of storing
an empty snapshot, and a prompt nobody can answer must change nothing.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import probe, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph

EXIT_NOT_FOUND = 7

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _snapshots(settings: Settings, s3: Any) -> None:
    """Reads the snapshots the lifecycle suite left, oldest first."""
    owners = storage.owner_segments(s3, settings.bucket, "outlook")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    snapshots = storage.snapshot_ids(s3, settings.bucket, owners[0])
    assert snapshots, "test_10_outlook left no snapshot to work on"
    STATE["owner"] = owners[0]
    STATE["snapshots"] = snapshots


def _snapshot_with_messages(cli: Cli) -> str:
    """A snapshot whose own run stored a message, which `--message 1` needs.

    Snapshot ids are UUIDs, so key order is not run order, and `list -s` and `--message` count only
    the messages a snapshot's own run recorded. Both lifecycle snapshots stored one, so the first
    that resolves is used.
    """
    for snapshot in STATE["snapshots"]:
        if cli.run("outlook", "read", "-s", snapshot, "--message", "1", "--raw").code == 0:
            return str(snapshot)
    pytest.fail("no snapshot resolves --message 1")


def test_01_read_raw_prints_the_stored_mime(cli: Cli, run_marker: str) -> None:
    """`outlook read --raw` decrypts one message and prints the MIME Exchange handed over.

    The subject header is the assertion: it is ASCII, so it survives whatever transfer encoding the
    body was given.
    """
    snapshot = _snapshot_with_messages(cli)
    STATE["snapshot"] = snapshot

    result = cli.ok("outlook", "read", "-s", snapshot, "--message", "1", "--raw")
    assert f"{run_marker}-mail-" in result.stdout, "the raw output does not carry the subject"
    assert "MIME-Version" in result.stdout, "the raw output is not a MIME message"


def test_02_read_formats_the_message(cli: Cli, run_marker: str) -> None:
    """The formatted view decodes the same message without error."""
    result = cli.ok("outlook", "read", "-s", STATE["snapshot"], "--message", "1")
    assert f"{run_marker}-mail-" in result.out, result.describe()


def test_03_an_unknown_message_reference_exits_not_found(cli: Cli) -> None:
    """A `--message` index past the end names nothing, on `read` and on `restore`."""
    for command in ("read", "restore"):
        result = cli.run("outlook", command, "-s", STATE["snapshot"], "--message", "99999")
        assert result.code == EXIT_NOT_FOUND, result.describe()


def test_04_a_folder_that_matches_nothing_stores_no_snapshot(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A mistyped `--folder` exits 7 instead of writing an empty snapshot and exiting 0."""
    before = storage.snapshot_ids(s3, settings.bucket, STATE["owner"])

    result = cli.run("outlook", "backup", "-m", settings.mailbox, "-f", f"{run_marker}-no-such")

    assert result.code == EXIT_NOT_FOUND, result.describe()
    assert storage.snapshot_ids(s3, settings.bucket, STATE["owner"]) == before, (
        "a backup that matched no folder still wrote a snapshot"
    )


def test_05_restore_lands_under_the_chosen_destination(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str
) -> None:
    """`--destination` replaces the generated `Restore-<timestamp>` root (#684).

    The destination carries the run marker, so the mailbox sweep removes it with the fixtures.
    """
    destination = f"{run_marker}-destination"
    cli.ok("outlook", "restore", "-s", STATE["snapshot"], "--destination", destination)

    root = probe.find_top_level_folder(graph, settings.mailbox, destination)
    assert root, f"no top-level folder named {destination} after the restore"
    subtree = list(probe.walk_folders(graph, settings.mailbox, str(root["id"])))
    assert any(f.get("displayName") == run_marker for f in subtree), (
        "the source folder was not recreated beneath the destination"
    )


def test_06_a_destination_inside_the_inbox_is_refused(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str
) -> None:
    """Restored mail never mixes into a well-known folder: exit 1, nothing created."""
    name = f"{run_marker}-in-inbox"
    result = cli.run(
        "outlook", "restore", "-s", STATE["snapshot"], "--destination", f"Inbox/{name}"
    )

    assert result.code == 1, result.describe()
    inbox = graph.get(f"/users/{settings.mailbox}/mailFolders/inbox", **{"$select": "id"})
    children = probe.child_folders(graph, settings.mailbox, str(inbox["id"]))
    assert not [f for f in children if f.get("displayName") == name], (
        "a refused restore still created its folder in the Inbox"
    )


def test_07_save_leaves_an_existing_file_alone_without_an_answer(
    cli: Cli, exports: Path, run_marker: str
) -> None:
    """With stdin at EOF the overwrite prompt gets no answer: exit 1, file untouched."""
    archive = exports / f"{run_marker}-existing.zip"
    archive.write_bytes(b"not a zip")

    result = cli.run("outlook", "save", "-s", STATE["snapshot"], "--output", str(archive), stdin="")

    assert result.code == 1, result.describe()
    assert archive.read_bytes() == b"not a zip", "an unanswered prompt still overwrote the file"
    STATE["archive"] = archive


def test_08_save_overwrites_with_yes(cli: Cli) -> None:
    """`-y` is what a scheduled export to a fixed path passes."""
    archive: Path = STATE["archive"]
    cli.ok("outlook", "save", "-s", STATE["snapshot"], "--output", str(archive), "-y")

    with zipfile.ZipFile(archive) as zf:
        assert [n for n in zf.namelist() if n.endswith(".eml")], zf.namelist()


def test_09_mailboxes_lists_the_tenant_live(cli: Cli) -> None:
    """`outlook mailboxes` reads Graph, not the catalog."""
    cli.ok("outlook", "mailboxes")


def test_10_list_users_reads_the_identity_registry(cli: Cli) -> None:
    """A backup registers its mailbox, so the registry is no longer empty."""
    result = cli.ok("list-users")
    assert "No users registered yet" not in result.out, result.describe()
