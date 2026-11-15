"""OneDrive sharing and version rollback: the drive features the lifecycle suite does not reach.

Runs after `test_20_onedrive` and backs up with the same `--folder` scope, so each backup here
resumes that suite's sync checkpoint instead of listing the drive again. The fixtures sit in a
subfolder of the run's fixture folder, which keeps the rollback in `test_06` away from the files
the lifecycle suite deleted and restored.

SharePoint shares this code path through `packages/drive`, so it is not repeated there.
"""

from __future__ import annotations

import os
import time
from datetime import timedelta
from typing import Any

import pytest

from atlas_e2e import drive, storage
from atlas_e2e.atlas import WHOLE_DRIVE_TIMEOUT, Cli
from atlas_e2e.config import Settings
from atlas_e2e.marker import parse_graph_time

STATE: dict[str, Any] = {}

ORGANIZATION_VIEW_LINK = {"type": "view", "scope": "organization"}


@pytest.fixture(scope="module", autouse=True)
def _requires_owner(settings: Settings) -> None:
    """Skips the whole module when no OneDrive owner is configured."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")


def test_01_seed_a_shared_file(graph: Any, settings: Settings, run_marker: str) -> None:
    """Uploads a file and shares it with an organization link."""
    drive_id = drive.user_drive_id(graph, settings.onedrive_owner)
    STATE["drive_id"] = drive_id
    STATE["folder"] = f"{drive.fixture_folder(run_marker)}/sharing"

    seeded = drive.upload_file(
        graph,
        drive_id,
        STATE["folder"],
        f"{run_marker}-shared.bin",
        os.urandom(drive.FIXTURE_BYTES),
    )
    drive.create_organization_link(graph, drive_id, seeded.item_id)
    STATE["first"] = seeded
    STATE["first_modified"] = drive.modified_at(graph, drive_id, seeded.item_id)

    assert ORGANIZATION_VIEW_LINK in drive.sharing_links(graph, drive_id, seeded.path)


def test_02_backup_captures_the_sharing(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A backup of the shared file writes a snapshot that `list-permissions` can read.

    `list-permissions` makes no Graph call, so the file's name in its output can only come from the
    permissions the backup stored.
    """
    _backup(cli, settings, run_marker)

    owners = storage.owner_segments(s3, settings.bucket, "onedrive")
    assert len(owners) == 1, f"expected one backed-up owner, found {len(owners)}"
    STATE["owner"] = owners[0]

    result = cli.ok("onedrive", "list-permissions", "-o", settings.onedrive_owner)
    assert STATE["first"].name in result.out, result.describe()
    cli.ok("onedrive", "list-snapshots", "-o", settings.onedrive_owner)


def test_03_restore_without_the_flag_shares_nothing(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """Sharing is opt-in: a plain restore brings the bytes back and applies no permission."""
    destination = f"/{drive.fixture_folder(run_marker)}/restored-unshared"
    _restore(cli, settings, s3, destination)

    restored = f"{destination}{STATE['first'].path}"
    assert drive.file_sha256(graph, STATE["drive_id"], restored) == STATE["first"].sha256
    assert drive.sharing_links(graph, STATE["drive_id"], restored) == [], (
        "a restore without --restore-permissions shared the restored file"
    )


def test_04_restore_permissions_recreates_the_link(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`--restore-permissions` gives the restored file a link of the same type and scope."""
    destination = f"/{drive.fixture_folder(run_marker)}/restored-shared"
    _restore(cli, settings, s3, destination, "--restore-permissions")

    restored = f"{destination}{STATE['first'].path}"
    assert drive.file_sha256(graph, STATE["drive_id"], restored) == STATE["first"].sha256
    assert ORGANIZATION_VIEW_LINK in drive.sharing_links(graph, STATE["drive_id"], restored), (
        "the organization link was not recreated on the restored file"
    )


def test_05_a_second_version_is_backed_up(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """Overwrites the file with new bytes, a clear interval after the first version.

    The wait makes the cutoff in the next test unambiguous: Graph reports modification times to the
    second, and the rollback picks versions by that time.
    """
    time.sleep(5)
    STATE["second"] = drive.upload_file(
        graph,
        STATE["drive_id"],
        STATE["folder"],
        STATE["first"].name,
        os.urandom(drive.FIXTURE_BYTES),
    )
    assert STATE["second"].item_id == STATE["first"].item_id, "the overwrite forked a new item"

    _backup(cli, settings, run_marker)
    cli.ok("onedrive", "list-versions", "-o", settings.onedrive_owner, "-f", STATE["first"].path)


def test_06_restore_version_writes_the_earlier_bytes_beside_the_file(
    cli: Cli, graph: Any, settings: Settings
) -> None:
    """`restore-version --before` rolls the folder back to the first version, without overwriting.

    The cutoff sits two seconds after the first version and before the second, so the rollback has
    to choose the older of two stored versions. The live file must still hold the second.
    """
    first_modified = parse_graph_time(STATE["first_modified"])
    assert first_modified is not None, "Graph returned no modification time for the first version"
    cutoff = (first_modified + timedelta(seconds=2)).strftime("%Y-%m-%dT%H:%M:%SZ")

    cli.ok(
        "onedrive",
        "restore-version",
        "-o",
        settings.onedrive_owner,
        "--before",
        cutoff,
        "--path",
        f"/{STATE['folder']}",
        timeout=WHOLE_DRIVE_TIMEOUT,
    )

    drive_id = STATE["drive_id"]
    names = [str(i["name"]) for i in drive.children(graph, drive_id, STATE["folder"])]
    digests = {drive.file_sha256(graph, drive_id, f"/{STATE['folder']}/{name}") for name in names}
    assert STATE["first"].sha256 in digests, f"no sibling holds the first version: {names}"
    assert drive.file_sha256(graph, drive_id, STATE["second"].path) == STATE["second"].sha256, (
        "the rollback overwrote the live file without --in-place"
    )


def _backup(cli: Cli, settings: Settings, run_marker: str) -> None:
    """Backs up the run's fixture folder, with the scope the lifecycle suite used."""
    cli.ok(
        "onedrive",
        "backup",
        "-o",
        settings.onedrive_owner,
        "--folder",
        f"/{drive.fixture_folder(run_marker)}",
        timeout=WHOLE_DRIVE_TIMEOUT,
    )


def _restore(cli: Cli, settings: Settings, s3: Any, destination: str, *flags: str) -> None:
    """Restores the shared file alone from the newest snapshot, under `destination`.

    `--file-filter` takes several values, so it goes last. Snapshot ids embed their creation time,
    so the greatest key is the newest snapshot.
    """
    snapshot = storage.snapshot_ids(s3, settings.bucket, STATE["owner"], "onedrive")[-1]
    cli.ok(
        "onedrive",
        "restore",
        "-o",
        settings.onedrive_owner,
        "-s",
        snapshot,
        "-c",
        "rename",
        "--destination",
        destination,
        *flags,
        "--file-filter",
        STATE["first"].path,
        timeout=WHOLE_DRIVE_TIMEOUT,
    )
