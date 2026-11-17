"""Drive selection and conflict handling on OneDrive: `--file-filter`, `-c`, `--name`, `--in-place`.

Runs after `test_20_onedrive` and `test_22_onedrive_sharing`, and backs up with the same `--folder`
scope, so each backup resumes their delta cursor instead of listing the drive again
(`folder-scope.ts:37-49`). The fixtures sit in their own subfolder of the run's fixture folder, and
every restore writes under that folder through `--destination` or back to its own path.

The selection rules are the shared `packages/drive` code SharePoint runs as well
(`restore-selection.ts:26-44`, `entry-filter.ts:41-51`), so they are exercised here once.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import drive, drive_extras
from atlas_e2e.atlas import Cli, Result
from atlas_e2e.config import Settings
from atlas_e2e.drive_extras import assert_exit

STATE: dict[str, Any] = {}

EXIT_UNCLASSIFIED = 1
EXIT_PARTIAL = 2
EXIT_NOT_FOUND = 7


@pytest.fixture(scope="module", autouse=True)
def _requires_owner(settings: Settings) -> None:
    """Skips the whole module when no OneDrive owner is configured."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")


def test_01_seed_and_back_up_three_files(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """Seeds `keep`, `extra` and `gone`, backs them up, and keeps that snapshot for later tests."""
    drive_id = drive.user_drive_id(graph, settings.onedrive_owner)
    STATE["drive_id"] = drive_id
    folder = f"{drive.fixture_folder(run_marker)}/selection"
    for label in ("keep", "extra", "gone"):
        STATE[label] = drive.upload_file(
            graph, drive_id, folder, f"{run_marker}-{label}.bin", os.urandom(drive.FIXTURE_BYTES)
        )

    drive_extras.onedrive_scoped_backup(cli, settings.onedrive_owner, run_marker)
    STATE["owner"] = drive_extras.sole_segment(s3, settings.bucket, "onedrive")
    STATE["before"] = drive_extras.newest_snapshot(s3, settings.bucket, STATE["owner"], "onedrive")


def test_02_restore_filter_matching_nothing_exits_7_and_writes_nothing(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """A filter that names no file is `ATLAS_NOT_FOUND` before any write (issue #707).

    The selection throws `NotFoundError` before the drive listing (`restore.service.ts:111-112`,
    `entry-filter.ts:46-49`), which exits 7 (`fatal-error.ts:9`). No destination folder may exist.
    """
    destination = _under(run_marker, "unmatched")
    result = _restore(cli, settings, "--destination", destination, "--file-filter", _absent())

    assert_exit(result, EXIT_NOT_FOUND)
    assert not drive_extras.item_exists(graph, STATE["drive_id"], destination), (
        "a restore that matched nothing created its destination"
    )


def test_03_restore_filter_partly_matching_exits_2_and_restores_the_match(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """Matching values are restored, the unmatched one is named and the run exits 2.

    `entry-filter.ts:20-24` returns the unmatched values, and `report_unmatched_file_filters` sets
    the partial exit (`command-run-outcome.ts:81-88`, called at `restore-presenter.tsx:70`).
    """
    destination = _under(run_marker, "partly")
    keep = STATE["keep"]
    filters = (keep.path, _absent())
    result = _restore(cli, settings, "--destination", destination, "--file-filter", *filters)

    assert_exit(result, EXIT_PARTIAL)
    restored = f"{destination}{keep.path}"
    assert drive.file_sha256(graph, STATE["drive_id"], restored) == keep.sha256


def test_04_save_filter_matching_nothing_exits_7_and_writes_no_archive(
    cli: Cli, settings: Settings, exports: Path, run_marker: str
) -> None:
    """`onedrive save` refuses an unmatched filter before it opens an archive.

    `save-snapshot.ts:82-85` selects before `create_file_archive`, and a path target is published
    only after a complete archive (`save-snapshot.ts:158-162`), so nothing may appear at the path.
    """
    archive = exports / f"{run_marker}-selection-none.zip"
    assert_exit(_save(cli, settings, archive, _absent()), EXIT_NOT_FOUND)

    assert not archive.exists(), "a save that matched nothing wrote an archive"


def test_05_save_filter_writes_only_the_named_file(
    cli: Cli, settings: Settings, exports: Path, run_marker: str
) -> None:
    """`onedrive save --file-filter` puts exactly the named file in the zip, with its bytes.

    Entry names are the parent path without its leading slash plus the file name
    (`file-save-zip-writer.ts:254-258`).
    """
    archive = exports / f"{run_marker}-selection-keep.zip"
    assert_exit(_save(cli, settings, archive, STATE["keep"].path), 0)

    assert drive_extras.zip_file_digests(archive) == {
        STATE["keep"].path.lstrip("/"): STATE["keep"].sha256
    }


def test_06_save_filter_partly_matching_exits_2_and_keeps_the_match(
    cli: Cli, settings: Settings, exports: Path, run_marker: str
) -> None:
    """A partly matching save still publishes the matched file and exits 2.

    The unmatched value is reported after the archive is written (`command.handlers.tsx:291`).
    """
    archive = exports / f"{run_marker}-selection-partly.zip"
    assert_exit(_save(cli, settings, archive, STATE["keep"].path, _absent()), EXIT_PARTIAL)

    assert drive_extras.zip_file_digests(archive) == {
        STATE["keep"].path.lstrip("/"): STATE["keep"].sha256
    }


def test_07_an_occupied_restore_target_is_prepared(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """Restores `keep` once, then overwrites the copy so the path holds bytes the snapshot lacks.

    The restore creates the nested folders, which a plain upload by path would not.
    """
    STATE["conflict_destination"] = _under(run_marker, "conflict")
    assert_exit(_conflict_restore(cli, settings, "rename"), 0)
    folder = f"{STATE['conflict_destination']}/{STATE['keep'].folder}".lstrip("/")
    STATE["conflict_folder"] = folder
    other_bytes = os.urandom(drive.FIXTURE_BYTES)
    STATE["occupant"] = drive.upload_file(
        graph, STATE["drive_id"], folder, STATE["keep"].name, other_bytes
    )

    assert _conflict_digests(graph) == {STATE["keep"].name: STATE["occupant"].sha256}


def test_08_conflict_fail_leaves_the_occupant_and_exits_2(
    cli: Cli, graph: Any, settings: Settings
) -> None:
    """`-c fail` refuses the upload; the file is counted as failed, so the run exits 2.

    The policy reaches Graph as `@microsoft.graph.conflictBehavior=fail`
    (`graph-onedrive-restore.adapter.ts:92-100`), and a thrown upload is a file error
    (`restore-file-entry.ts:73-78`) that `report_drive_restore` turns into exit 2.
    """
    assert_exit(_conflict_restore(cli, settings, "fail"), EXIT_PARTIAL)

    assert _conflict_digests(graph) == {STATE["keep"].name: STATE["occupant"].sha256}


def test_09_conflict_rename_writes_a_sibling(cli: Cli, graph: Any, settings: Settings) -> None:
    """`-c rename`, the default (`shared-options.ts:70-77`), keeps the occupant and adds a copy."""
    assert_exit(_conflict_restore(cli, settings, "rename"), 0)

    digests = _conflict_digests(graph)
    assert len(digests) == 2, f"expected the occupant and one renamed copy: {sorted(digests)}"
    assert digests[STATE["keep"].name] == STATE["occupant"].sha256, "rename touched the occupant"
    assert STATE["keep"].sha256 in digests.values(), "no sibling holds the snapshot's bytes"


def test_10_conflict_replace_overwrites_in_place(cli: Cli, graph: Any, settings: Settings) -> None:
    """`-c replace` writes the snapshot's bytes over the occupant and adds no file."""
    assert_exit(_conflict_restore(cli, settings, "replace"), 0)

    digests = _conflict_digests(graph)
    assert len(digests) == 2, f"replace added or removed a file: {sorted(digests)}"
    assert digests[STATE["keep"].name] == STATE["keep"].sha256, "replace left the occupant"


def test_11_name_renames_a_single_file_restore(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """`--name` writes the one selected file under the new name (`restore.service.ts:173`)."""
    destination = _under(run_marker, "renamed")
    new_name = f"{run_marker}-renamed.bin"
    keep = STATE["keep"]
    flags = ("--destination", destination, "--name", new_name)
    result = _restore(cli, settings, *flags, "--file-filter", keep.path)

    assert_exit(result, 0)
    folder = f"{destination}/{keep.folder}"
    assert drive_extras.folder_digests(graph, STATE["drive_id"], folder) == {new_name: keep.sha256}


def test_12_name_refuses_a_restore_of_two_files(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """`--name` with two matching files is refused before any folder is created.

    `assert_renameable` throws a plain `Error` (`restore-destination.ts:46-53`), which carries no
    Atlas code and exits 1 (`fatal-error.ts:95-111`). It runs before the first file
    (`restore.service.ts:122`), so the destination must not exist.
    """
    destination = _under(run_marker, "renamed-twice")
    flags = ("--destination", destination, "--name", f"{run_marker}-twice.bin")
    filters = (STATE["keep"].path, STATE["extra"].path)
    result = _restore(cli, settings, *flags, "--file-filter", *filters)

    assert_exit(result, EXIT_UNCLASSIFIED)
    assert not drive_extras.item_exists(graph, STATE["drive_id"], destination)


def test_13_a_deletion_is_recorded_by_the_scoped_backup(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """Deletes `gone` in OneDrive and backs up again with the same `--folder` scope.

    Graph omits the parent of a removed item, so the scope check uses the path the cursor remembered
    (`folder-scope.ts:59-68`), and the item becomes a `deleted` entry
    (`delta-item-processor.ts:135-146`).
    """
    drive.delete_item(graph, STATE["drive_id"], STATE["gone"].item_id)
    assert drive.file_sha256(graph, STATE["drive_id"], STATE["gone"].path) is None

    drive_extras.onedrive_scoped_backup(cli, settings.onedrive_owner, run_marker)
    STATE["after"] = drive_extras.newest_snapshot(s3, settings.bucket, STATE["owner"], "onedrive")
    assert STATE["after"] != STATE["before"], "the backup wrote no new snapshot"


def test_14_the_newest_snapshot_does_not_bring_the_deleted_file_back(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """The tombstone wins over the earlier stored version: the file is not restorable any more.

    The chain keeps each file's newest entry (`drive-snapshot-chain.ts:30-45`) and drops a
    `deleted` one (`manifest-chain.ts:55-61`), so a filter naming the file matches nothing and
    exits 7. The same filter restores it from the earlier snapshot in the next test.
    """
    destination = _under(run_marker, "tombstone")
    flags = ("--destination", destination, "--file-filter", STATE["gone"].path)
    result = drive_extras.onedrive_restore(cli, settings.onedrive_owner, STATE["after"], *flags)

    assert_exit(result, EXIT_NOT_FOUND)
    assert drive.file_sha256(graph, STATE["drive_id"], STATE["gone"].path) is None
    assert not drive_extras.item_exists(graph, STATE["drive_id"], destination)


def test_15_in_place_restore_puts_the_deleted_file_back(
    cli: Cli, graph: Any, settings: Settings
) -> None:
    """`--in-place` restores the deleted file to its original path from the earlier snapshot.

    In-place means an empty restore root (`restore-destination.ts:24-25`), so the parent path the
    manifest recorded is the target, and nothing is there any more to conflict with.
    """
    assert_exit(_restore(cli, settings, "--in-place", "--file-filter", STATE["gone"].path), 0)

    assert drive.file_sha256(graph, STATE["drive_id"], STATE["gone"].path) == STATE["gone"].sha256


def _under(run_marker: str, name: str) -> str:
    """A restore destination inside this run's fixture folder, which cleanup owns."""
    return f"/{drive.fixture_folder(run_marker)}/{name}"


def _absent() -> str:
    """A rooted path beside the seeded files that no backup ever saw."""
    return f"{STATE['keep'].path.rsplit('/', 1)[0]}/never-seeded.bin"


def _restore(cli: Cli, settings: Settings, *args: str) -> Result:
    """Restores from the snapshot taken before `gone` was deleted."""
    return drive_extras.onedrive_restore(cli, settings.onedrive_owner, STATE["before"], *args)


def _save(cli: Cli, settings: Settings, archive: Path, *filters: str) -> Result:
    """Saves from the snapshot taken before `gone` was deleted."""
    return drive_extras.onedrive_save(
        cli, settings.onedrive_owner, STATE["before"], archive, *filters
    )


def _conflict_restore(cli: Cli, settings: Settings, mode: str) -> Result:
    """Restores `keep` onto the conflict tests' target with one conflict policy."""
    flags = ("--destination", STATE["conflict_destination"], "-c", mode)
    return _restore(cli, settings, *flags, "--file-filter", STATE["keep"].path)


def _conflict_digests(graph: Any) -> dict[str, str | None]:
    """What the conflict tests' target folder holds, by name."""
    return drive_extras.folder_digests(graph, STATE["drive_id"], STATE["conflict_folder"])
