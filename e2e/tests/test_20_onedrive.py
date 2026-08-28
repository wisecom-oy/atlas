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
from atlas_e2e.atlas import Cli, WHOLE_DRIVE_TIMEOUT
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _requires_owner(settings: Settings) -> None:
    """Skips the whole module when no OneDrive owner is configured."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")


def test_01_seed_a_file(graph: Any, settings: Settings, run_marker: str) -> None:
    """Uploads the first version of the fixture file, plus a 5 MB file.

    The large one is what makes the rest of this module cover chunked download, streaming restore
    and multi-chunk upload. Without it every path below runs the small-file branch only, which is
    how #143 shipped past a green nightly.
    """
    drive_id = drive.user_drive_id(graph, settings.onedrive_owner)
    STATE["drive_id"] = drive_id
    STATE["file"] = drive.seed_fixture_file(graph, drive_id, run_marker)
    STATE["large"] = drive.seed_large_fixture_file(graph, drive_id, run_marker)

    assert drive.file_sha256(graph, drive_id, STATE["file"].path) == STATE["file"].sha256
    assert drive.file_sha256(graph, drive_id, STATE["large"].path) == STATE["large"].sha256


def test_02_backup_writes_blobs_and_index(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """Backs up the owner's drive and asserts blobs, a manifest, and a version index landed.

    Scoped to this run's fixture folder with `--folder`. Without it the backup syncs the owner's
    entire drive, so the suite's runtime and object counts depended on whatever else that account
    happened to hold, and a drive with many items pushed the call past its timeout. Scoping keeps
    the assertions about the fixtures and nothing else.

    The timeout stays generous anyway: Graph's driveItem delta is drive-wide, so the enumeration
    still pages the whole drive even though only the scoped items are downloaded.
    """
    cli.ok(
        "onedrive",
        "backup",
        "-o",
        settings.onedrive_owner,
        "--folder",
        f"/{drive.fixture_folder(run_marker)}",
        timeout=WHOLE_DRIVE_TIMEOUT,
    )

    owner = _owner_segment(s3, settings.bucket)
    STATE["owner"] = owner

    snapshots = storage.snapshot_ids(s3, settings.bucket, owner, "onedrive")
    assert len(snapshots) == 1, f"expected one OneDrive snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]

    assert storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/"), "no file blob written"

    # One version-index object per run, not per file: issue #161 retired the
    # `index/<owner>/files/<item_id>.json` layout because Hetzner bills a 64 KB minimum per object.
    # Reads still merge legacy per-file objects, but a fresh bucket has none, so the run shard is the
    # only thing that can be asserted from key names here. Per-file visibility is covered by
    # `list-versions` in the next test, which exercises the read path.
    assert f"onedrive/index/{owner}/runs/{STATE['snapshot']}.json" in storage.list_keys(
        s3, settings.bucket, f"onedrive/index/{owner}/runs/"
    ), "the run wrote no version index shard"


def test_03_a_new_version_is_stored_incrementally(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """Uploading a second version and re-running the backup stores exactly one more blob.

    Measured as a delta rather than an absolute count: the backup covers the whole drive, so a
    fixed expectation would depend on what else the owner keeps in OneDrive. Random fixtures cannot
    deduplicate, so exactly one new content-addressed key is the honest signal that the new version
    was captured and the old one retained.
    """
    owner = STATE["owner"]
    before = set(storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/"))

    STATE["file"] = drive.seed_fixture_file(graph, STATE["drive_id"], run_marker)
    # Same scope as the initial run: a scope change would force a re-crawl instead of
    # resuming the delta link, and this test is specifically about the incremental path.
    cli.ok(
        "onedrive",
        "backup",
        "-o",
        settings.onedrive_owner,
        "--folder",
        f"/{drive.fixture_folder(run_marker)}",
        timeout=WHOLE_DRIVE_TIMEOUT,
    )

    after = set(storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/"))
    assert len(after - before) == 1, f"expected one new version blob, got {len(after - before)}"
    assert before <= after, "an incremental run must not remove existing blobs"

    snapshots = storage.snapshot_ids(s3, settings.bucket, owner, "onedrive")
    assert len(snapshots) == 2, f"expected a second snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[-1]

    cli.ok("onedrive", "list-versions", "-o", settings.onedrive_owner, "-f", STATE["file"].path)


def test_04_verify_passes(cli: Cli, settings: Settings) -> None:
    """Deep verification of the snapshot: blobs decrypt, hash, and match the index rows."""
    cli.ok(
        "onedrive",
        "verify",
        "-o",
        settings.onedrive_owner,
        "-s",
        STATE["snapshot"],
        timeout=WHOLE_DRIVE_TIMEOUT,
    )


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
        timeout=WHOLE_DRIVE_TIMEOUT,
    )

    assert archive.exists(), f"{archive} was not written"
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        assert any(STATE["file"].name in n for n in names), names
        large = next((n for n in names if STATE["large"].name in n), None)
        assert large is not None, names
        # #143: export of a file over 4 MB aborted mid-stream, so the size is the assertion.
        assert zf.getinfo(large).file_size == drive.LARGE_FIXTURE_BYTES


def test_06_restore_recreates_a_deleted_file(
    cli: Cli, graph: Any, settings: Settings, run_marker: str
) -> None:
    """Deletes the files from OneDrive and restores them under this run's destination.

    Issue #217: a restore now nests under a root instead of writing back over live content. The
    suite passes `--destination` rather than taking the default `Restore-<timestamp>` root, because
    that default lands at the drive root, outside the marker namespace cleanup is allowed to touch.
    `--conflict rename` is still passed explicitly: an unexpected collision must never overwrite.
    """
    for file in (STATE["file"], STATE["large"]):
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
        "--destination",
        drive.restore_destination(run_marker),
        timeout=WHOLE_DRIVE_TIMEOUT,
    )


def test_07_restored_bytes_match_the_seed(graph: Any, settings: Settings, run_marker: str) -> None:
    """Both restored files hash to their newest seeded version, read back through Graph."""
    tree = drive.restored_tree(run_marker)
    restored = drive.children(graph, STATE["drive_id"], tree.lstrip("/"))
    assert restored, f"no files under {tree} after restore"

    digests = {
        drive.file_sha256(graph, STATE["drive_id"], f"{tree}/{item['name']}") for item in restored
    }
    assert STATE["file"].sha256 in digests, "no restored file matches the seeded bytes"
    assert STATE["large"].sha256 in digests, "no restored file matches the 5 MB seeded bytes"

    # The point of the restore root: live content is left alone. These paths were deleted in
    # test_06 and a pre-#217 restore would have put them back, mixed in with real files.
    for file in (STATE["file"], STATE["large"]):
        assert (
            drive.file_sha256(graph, STATE["drive_id"], file.path) is None
        ), f"restore wrote back to the original path {file.path}"


def test_08_status_reports_the_stored_snapshot(cli: Cli, settings: Settings) -> None:
    """`onedrive status` reaches Graph and the manifest chain, and names the last snapshot.

    Wired to the CLI by #163: the status use case existed and only the SDK could reach it.
    """
    result = cli.ok("onedrive", "status", "-o", settings.onedrive_owner)

    assert STATE["snapshot"] in result.out, result.describe()


def _owner_segment(s3: Any, bucket: str) -> str:
    """Reads the owner segment Atlas used, rather than assuming how the email was normalised."""
    keys = storage.list_keys(s3, bucket, "onedrive/manifests/")
    owners = {key.split("/")[2] for key in keys}
    assert len(owners) == 1, f"expected exactly one backed-up owner, found {sorted(owners)}"
    return owners.pop()
