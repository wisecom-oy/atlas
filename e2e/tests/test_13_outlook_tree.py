"""Outlook depth: a three-level folder tree through backup, change, restore and save.

Runs after `test_12_outlook_options` and backs up its own top-level folder, `<run_marker>-tree`,
always through `--folder`. The bare name never equals a segment of `test_10`'s fixture paths, so
neither suite's backups reach the other's mail, and this module's new snapshots extend the same
mailbox chain that later suites list, verify and purge.

Every backup runs before any restore. A `--folder` selector matches a bare name at any depth, so a
restored copy under `<destination>/<run_marker>-tree/` would re-enter the scope of a later backup.

Seeded layout, with `T` for `<run_marker>-tree`:

    T        top, large (4 MiB attachment), later late-top
    T/A      middle, changed, moved
    T/A/C    deep, deleted, later late-deep
    T/B      sibling
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import mail_extras, probe, seed, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph

STATE: dict[str, Any] = {}

# Message label -> folder key. `T` is the tree root.
SEEDED = {
    "top": "T",
    "large": "T",
    "middle": "A",
    "changed": "A",
    "moved": "A",
    "deep": "C",
    "deleted": "C",
    "sibling": "B",
}
LATE = {"late-top": "T", "late-deep": "C"}


def _names(marker: str) -> dict[str, str]:
    """Folder key -> path relative to the mailbox root, and to any restore destination."""
    tree = f"{marker}-tree"
    return {
        "T": tree,
        "A": f"{tree}/{tree}-a",
        "C": f"{tree}/{tree}-a/{tree}-c",
        "B": f"{tree}/{tree}-b",
    }


def _subject(marker: str, label: str) -> str:
    return f"{marker}-tree-{label}"


def _only(placement: dict[str, str], *keys: str) -> dict[str, str]:
    """The labels of `placement` that sit in one of `keys`."""
    return {label: key for label, key in placement.items() if key in keys}


def _layout(marker: str, keys: list[str], placement: dict[str, str]) -> dict[str, list[str]]:
    """The `{path: sorted subjects}` a restore should produce: every folder in `keys`, holding the
    labels `placement` puts there. A folder recreated only as a path level holds nothing."""
    names = _names(marker)
    return {
        names[key]: sorted(_subject(marker, label) for label, at in placement.items() if at == key)
        for key in keys
    }


@pytest.fixture(scope="module", autouse=True)
def _owner(settings: Settings, s3: Any) -> None:
    """The one mailbox owner segment `test_10_outlook` created."""
    owners = storage.owner_segments(s3, settings.bucket, "outlook")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    STATE["owner"] = owners[0]


def _backup(cli: Cli, settings: Settings, s3: Any, *args: str) -> tuple[str, set[str], set[str]]:
    """Runs one backup that must write a snapshot. Returns it and the data keys before and after."""
    owner = STATE["owner"]
    snapshots = set(storage.snapshot_ids(s3, settings.bucket, owner))
    before = set(storage.list_keys(s3, settings.bucket, f"data/{owner}/"))

    cli.ok("outlook", "backup", "-m", settings.mailbox, *args)

    new = set(storage.snapshot_ids(s3, settings.bucket, owner)) - snapshots
    assert len(new) == 1, f"expected one new snapshot, found {len(new)}"
    after = set(storage.list_keys(s3, settings.bucket, f"data/{owner}/"))
    assert before <= after, "a backup removed stored message blobs"
    return new.pop(), before, after


def _restored(
    graph: Graph, settings: Settings, destination: str
) -> dict[str, list[dict[str, Any]]]:
    root = probe.find_top_level_folder(graph, settings.mailbox, destination)
    assert root, f"no top-level folder named {destination} after the restore"
    return mail_extras.messages_by_path(graph, settings.mailbox, str(root["id"]))


def _seed(graph: Graph, settings: Settings, marker: str, placement: dict[str, str]) -> None:
    for label, key in placement.items():
        STATE["ids"][label] = mail_extras.create_received_message(
            graph, settings.mailbox, STATE["folders"][key], _subject(marker, label)
        )


def test_01_seed_a_three_level_tree(graph: Graph, settings: Settings, run_marker: str) -> None:
    """Creates `T`, `T/A`, `T/A/C` and `T/B`, a message or more in each, and a 4 MiB attachment.

    The attachment is seeded through an upload session because Graph refuses 3 MB and up in one
    POST, which is also the size at which restore switches to an upload session.
    """
    mailbox = settings.mailbox
    tree = f"{run_marker}-tree"
    folders = {"T": seed.create_folder(graph, mailbox, tree)}
    folders["A"] = seed.create_folder(graph, mailbox, f"{tree}-a", folders["T"])
    folders["C"] = seed.create_folder(graph, mailbox, f"{tree}-c", folders["A"])
    folders["B"] = seed.create_folder(graph, mailbox, f"{tree}-b", folders["T"])
    STATE["folders"] = folders
    STATE["ids"] = {}
    _seed(graph, settings, run_marker, SEEDED)

    payload = os.urandom(mail_extras.LARGE_ATTACHMENT_BYTES)
    STATE["large_name"] = f"{run_marker}-tree-large.bin"
    STATE["large_sha256"] = hashlib.sha256(payload).hexdigest()
    mail_extras.attach_large_file(
        graph, mailbox, STATE["ids"]["large"], STATE["large_name"], payload
    )

    assert set(mail_extras.folder_paths(graph, mailbox, folders["T"])) == {
        p.removeprefix(f"{tree}/") for k, p in _names(run_marker).items() if k != "T"
    }


def test_02_small_pages_still_store_every_message(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`-P 2` splits `T/A`'s three messages over two delta pages, and all eight are stored.

    Eight distinct messages are eight distinct content-addressed blobs, so the count is exact.
    """
    snapshot, before, after = _backup(cli, settings, s3, "-f", f"{run_marker}-tree", "-P", "2")
    assert len(after - before) == len(SEEDED), f"stored {len(after - before)} new blob(s)"
    STATE["first"] = snapshot


def test_03_a_full_path_selector_backs_up_only_that_subtree(
    cli: Cli, graph: Graph, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`-f T/A` captures the new message in `T/A/C` and leaves the new one in `T` alone."""
    _seed(graph, settings, run_marker, LATE)

    _, before, after = _backup(cli, settings, s3, "-f", _names(run_marker)["A"])
    assert len(after - before) == 1, f"expected only late-deep, got {len(after - before)} blob(s)"


def test_04_an_incremental_run_records_a_change_and_a_move(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str, s3: Any
) -> None:
    """Flags `changed`, moves `moved` from `T/A` to `T/B`, deletes `deleted` and `large`.

    Then backs up `T`. The run picks up `late-top`, so it stores at least one new blob.
    """
    mailbox, ids = settings.mailbox, STATE["ids"]
    mail_extras.flag_message(graph, mailbox, ids["changed"])
    mail_extras.move_message(graph, mailbox, ids["moved"], STATE["folders"]["B"])
    probe.delete_message(graph, mailbox, ids["deleted"])
    probe.delete_message(graph, mailbox, ids["large"])

    _, before, after = _backup(cli, settings, s3, "-f", f"{run_marker}-tree")
    assert after - before, "the incremental run did not store late-top"


def test_05_full_rereads_without_storing_a_blob_twice(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`--full` ignores the saved delta links: it always writes a snapshot, and unchanged mail
    deduplicates against the content-addressed blobs already stored, so no data key is added.
    """
    _, before, after = _backup(cli, settings, s3, "-f", f"{run_marker}-tree", "--full")
    assert after == before, f"--full stored {len(after - before)} blob(s) for unchanged mail"


def test_06_snapshot_restore_of_a_subtree_recreates_its_hierarchy(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str
) -> None:
    """`restore -s <first> -f T/A` rebuilds `T/A/C` beneath the destination and nothing else.

    The first snapshot predates every change, so `changed` comes back unflagged and `moved` and
    `deleted` come back where they were.
    """
    destination = f"{run_marker}-tree-r1"
    cli.ok(
        "outlook",
        "restore",
        "-s",
        STATE["first"],
        "-f",
        _names(run_marker)["A"],
        "--destination",
        destination,
    )

    restored = _restored(graph, settings, destination)
    assert mail_extras.subjects_by_path(restored) == _layout(
        run_marker, ["T", "A", "C"], _only(SEEDED, "A", "C")
    )
    [(_, changed)] = mail_extras.find_by_subject(restored, _subject(run_marker, "changed"))
    assert mail_extras.flag_status(changed) != "flagged", "the first snapshot never saw the flag"


def test_07_save_of_a_subtree_mirrors_the_hierarchy(
    cli: Cli, exports: Path, run_marker: str
) -> None:
    """`save -s <first> -f T/A` writes only that subtree, one zip directory per folder path."""
    archive = exports / f"{run_marker}-tree-subtree.zip"
    cli.ok(
        "outlook",
        "save",
        "-s",
        STATE["first"],
        "-f",
        _names(run_marker)["A"],
        "--output",
        str(archive),
    )

    expected = _layout(run_marker, ["A", "C"], SEEDED)
    assert mail_extras.archive_subjects_by_dir(archive) == expected


def test_08_message_index_restores_and_saves_exactly_one(
    cli: Cli, graph: Graph, settings: Settings, exports: Path, run_marker: str
) -> None:
    """`--message 1` names the first entry of the snapshot on `save` and on `restore` alike.

    The index counts the snapshot's own entries in the order its run stored them, which the suite
    cannot predict, so the proof is that both commands produce the same single message.
    """
    archive = exports / f"{run_marker}-tree-one.zip"
    cli.ok("outlook", "save", "-s", STATE["first"], "--message", "1", "--output", str(archive))
    saved = [
        s for subjects in mail_extras.archive_subjects_by_dir(archive).values() for s in subjects
    ]
    assert len(saved) == 1, f"save --message 1 wrote {len(saved)} messages"

    destination = f"{run_marker}-tree-r2"
    cli.ok(
        "outlook", "restore", "-s", STATE["first"], "--message", "1", "--destination", destination
    )
    restored = _restored(graph, settings, destination)
    found = [(p, m) for p, msgs in restored.items() for m in msgs]
    assert len(found) == 1, f"restore --message 1 created {len(found)} messages"

    path, message = found[0]
    assert message.get("subject") == saved[0], "save and restore picked different messages"
    label = str(saved[0]).removeprefix(f"{run_marker}-tree-")
    assert path == _names(run_marker)[SEEDED[label]], "the message left its source folder path"


def test_09_mailbox_restore_keeps_the_newest_version_of_each_message(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str
) -> None:
    """`restore -m -f T` merges every snapshot, newest entry per message id winning.

    `changed` comes back once and flagged, `moved` once and under `T/B`. `deleted` and `large`
    come back too: every run here used `--folder`, and such a run never records a removal.
    """
    destination = f"{run_marker}-tree-r3"
    cli.ok(
        "outlook",
        "restore",
        "-m",
        settings.mailbox,
        "-f",
        f"{run_marker}-tree",
        "--destination",
        destination,
    )

    final = {**SEEDED, **LATE, "moved": "B"}
    restored = _restored(graph, settings, destination)
    STATE["merged"] = restored
    assert mail_extras.subjects_by_path(restored) == _layout(
        run_marker, ["T", "A", "C", "B"], final
    )
    [(_, changed)] = mail_extras.find_by_subject(restored, _subject(run_marker, "changed"))
    assert mail_extras.flag_status(changed) == "flagged", "an older version of `changed` won"


def test_10_a_large_attachment_restores_byte_identical(
    graph: Graph, settings: Settings, run_marker: str
) -> None:
    """The 4 MiB attachment of the deleted `large` came back through an upload session intact."""
    [(_, large)] = mail_extras.find_by_subject(STATE["merged"], _subject(run_marker, "large"))
    digest = mail_extras.attachment_sha256(
        graph, settings.mailbox, str(large["id"]), STATE["large_name"]
    )
    assert digest == STATE["large_sha256"], "restored attachment does not match the seeded bytes"


def test_11_restore_into_a_second_mailbox(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str
) -> None:
    """`-T` writes a snapshot's subtree into another mailbox, folder paths and all.

    Needs `E2E_SECOND_MAILBOX`. The destination is removed from that mailbox afterwards, since the
    session teardown sweeps only `E2E_MAILBOX`.
    """
    target = settings.second_mailbox
    if not target:
        pytest.skip("E2E_SECOND_MAILBOX is not set")
    destination = f"{run_marker}-tree-cross"
    try:
        cli.ok(
            "outlook",
            "restore",
            "-s",
            STATE["first"],
            "-f",
            _names(run_marker)["C"],
            "-T",
            target,
            "--destination",
            destination,
        )
        root = probe.find_top_level_folder(graph, target, destination)
        assert root, "no destination folder in the second mailbox"
        restored = mail_extras.messages_by_path(graph, target, str(root["id"]))
        assert mail_extras.subjects_by_path(restored) == _layout(
            run_marker, ["T", "A", "C"], _only(SEEDED, "C")
        )
    finally:
        root = probe.find_top_level_folder(graph, target, destination)
        if root:
            graph.delete(f"/users/{target}/mailFolders/{root['id']}")
