"""OneDrive lifecycle: seed two versions, back up, destroy in M365, restore, compare bytes.

Ordered like the Outlook suite and for the same reason: each step depends on the last. The restore
runs after the version assertions, because a restored copy changes what is in the drive.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import drive, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _requires_owner(settings: Settings) -> None:
    """Skips the whole module when no OneDrive owner is configured."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")


def test_01_seed_two_versions(graph: Any, settings: Settings, run_marker: str) -> None:
    """Uploads the fixture file twice, so the version index has something to index."""
    drive_id = drive.user_drive_id(graph, settings.onedrive_owner)
    STATE["drive_id"] = drive_id
    STATE["file"] = drive.seed_fixture_file(graph, drive_id, run_marker, versions=2)

    assert drive.file_sha256(graph, drive_id, STATE["file"].path) == STATE["file"].sha256


def test_02_backup_writes_blobs_and_index(cli: Cli, settings: Settings, s3: Any) -> None:
    """Backs up the owner's drive and asserts blobs, a manifest, and a version index landed."""
    cli.ok("onedrive", "backup", "-o", settings.onedrive_owner)

    owner = _owner_segment(s3, settings.bucket)
    STATE["owner"] = owner

    snapshots = storage.snapshot_ids(s3, settings.bucket, owner, "onedrive")
    assert len(snapshots) == 1, f"expected one OneDrive snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]

    assert storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/"), "no file blob written"
    assert storage.list_keys(s3, settings.bucket, f"onedrive/index/{owner}/files/"), "no version index"


def test_03_both_seeded_versions_are_stored(cli: Cli, settings: Settings, s3: Any) -> None:
    """Two uploads of the same item are stored as two blobs and one version index.

    Counting content-addressed blobs is the measurable form of "both versions were kept": the
    fixtures are random, so two versions cannot deduplicate into one key. The index itself is
    encrypted, so its readability is checked by running `list-versions` rather than by parsing it.
    """
    owner, file_id = STATE["owner"], STATE["file"].item_id
    assert f"onedrive/index/{owner}/files/{file_id}.json" in storage.list_keys(
        s3, settings.bucket, f"onedrive/index/{owner}/files/"
    ), "the seeded file has no version index of its own"

    blobs = storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/")
    assert len(blobs) == 2, f"expected two version blobs for two uploads, found {len(blobs)}"

    cli.ok("onedrive", "list-versions", "-o", settings.onedrive_owner, "-f", STATE["file"].path)


def test_04_verify_passes(cli: Cli, settings: Settings) -> None:
    """Deep verification of the snapshot: blobs decrypt, hash, and match the index rows."""
    cli.ok("onedrive", "verify", "-o", settings.onedrive_owner, "-s", STATE["snapshot"])


def test_05_save_exports_the_file(cli: Cli, settings: Settings, exports: Path, run_marker: str) -> None:
    """`onedrive save` writes a zip that mirrors the drive hierarchy.

    Note the capital `-O` for output: `onedrive save` differs from `outlook save` here, and `-o` is
    the owner.
    """
    archive = exports / f"{run_marker}-onedrive.zip"
    cli.ok(
        "onedrive",
        "save",
        "-o",
        settings.onedrive_owner,
        "-s",
        STATE["snapshot"],
        "-O",
        str(archive),
    )

    assert archive.exists(), f"{archive} was not written"
    with zipfile.ZipFile(archive) as zf:
        assert any(STATE["file"].name in n for n in zf.namelist()), zf.namelist()


def test_06_restore_recreates_a_deleted_file(cli: Cli, graph: Any, settings: Settings) -> None:
    """Deletes the file from OneDrive and restores it from the snapshot.

    `--conflict rename` is the default and is passed explicitly: OneDrive restore writes back to the
    original `parent_path` with no `Restore-` root of its own, so an unexpected collision must never
    overwrite live data.
    """
    file = STATE["file"]
    drive.delete_item(graph, STATE["drive_id"], file.item_id)
    assert drive.file_sha256(graph, STATE["drive_id"], file.path) is None, "file survived deletion"

    cli.ok(
        "onedrive",
        "restore",
        "-o",
        settings.onedrive_owner,
        "-s",
        STATE["snapshot"],
        "-c",
        "rename",
    )


def test_07_restored_bytes_match_the_seed(graph: Any, settings: Settings, run_marker: str) -> None:
    """The restored file hashes to the newest seeded version, read back through Graph."""
    file = STATE["file"]
    restored = drive.children(graph, STATE["drive_id"], run_marker)
    assert restored, f"no files under /{run_marker} after restore"

    digests = {
        drive.file_sha256(graph, STATE["drive_id"], f"/{run_marker}/{item['name']}") for item in restored
    }
    assert file.sha256 in digests, "no restored file matches the seeded bytes"


def _owner_segment(s3: Any, bucket: str) -> str:
    """Reads the owner segment Atlas used, rather than assuming how the email was normalised."""
    keys = storage.list_keys(s3, bucket, "onedrive/manifests/")
    owners = {key.split("/")[2] for key in keys}
    assert len(owners) == 1, f"expected exactly one backed-up owner, found {sorted(owners)}"
    return owners.pop()
