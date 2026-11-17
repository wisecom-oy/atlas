"""SharePoint sharing and version rollback: what `test_22` proves for OneDrive, on a site library.

Runs after `test_30_sharepoint` and backs up exactly as it does, `--site <url>` with no `--full`,
so every backup here resumes that suite's delta cursor. `sharepoint backup` has no folder scope, so
the site's whole library is the scope. The fixtures sit in a subfolder of the run's fixture folder,
away from the files `test_30` deleted and restored, so the rollback below sees only its own file.

What is SharePoint's own here: the `--site` and `--target-site` addressing, and library routing.
Every restore entry records its library's name (`library-item-processor.ts:100`), and a restore to
another site picks the target library by that name (`restore-target.ts:29-46`). The sharing code
itself is the shared `packages/drive` path, so a site-group grant the item carries is skipped with a
reason and never changes the exit code (`permission-restore.ts:147-150`).

A direct grant is not covered: `POST /invite` needs a real user or group as the recipient
(`graph-sharing-writes.ts:12-15`), and the suite has no second identity to grant to.
"""

from __future__ import annotations

import os
import time
from datetime import timedelta
from typing import Any

import pytest

from atlas_e2e import drive, drive_extras, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.marker import parse_graph_time

STATE: dict[str, Any] = {}

ORGANIZATION_VIEW_LINK = {"type": "view", "scope": "organization"}


@pytest.fixture(scope="module", autouse=True)
def _requires_site(settings: Settings) -> None:
    """Skips the whole module when no SharePoint site is configured."""
    if not settings.sharepoint_site:
        pytest.skip("E2E_SHAREPOINT_SITE not set")


def test_01_seed_a_shared_library_file(graph: Any, settings: Settings, run_marker: str) -> None:
    """Uploads a file into the site's default library and shares it with an organization link."""
    composite_id = drive.site_id(graph, settings.sharepoint_site)
    drive_id = drive.site_drive_id(graph, composite_id)
    STATE["drive_id"] = drive_id
    STATE["folder"] = f"{drive.fixture_folder(run_marker)}/spsharing"

    seeded = drive.upload_file(
        graph,
        drive_id,
        STATE["folder"],
        f"{run_marker}-sp-shared.bin",
        os.urandom(drive.FIXTURE_BYTES),
    )
    drive.create_organization_link(graph, drive_id, seeded.item_id)
    STATE["first"] = seeded
    STATE["first_modified"] = drive.modified_at(graph, drive_id, seeded.item_id)

    assert ORGANIZATION_VIEW_LINK in drive.sharing_links(graph, drive_id, seeded.path)


def test_02_backup_captures_the_sharing(cli: Cli, settings: Settings, s3: Any) -> None:
    """An incremental site backup writes one snapshot that `list-permissions` can read.

    `list-permissions` reads the stored manifests and makes no Graph call for permissions
    (`catalog.command.tsx:178-187`), so the file's name in its output can only come from what the
    backup captured. The table is the only place that is visible, hence the one string check.
    """
    site = drive_extras.sole_segment(s3, settings.bucket, "sharepoint")
    STATE["site"] = site
    before = set(storage.snapshot_ids(s3, settings.bucket, site, "sharepoint"))

    _backup(cli, settings)

    added = set(storage.snapshot_ids(s3, settings.bucket, site, "sharepoint")) - before
    assert len(added) == 1, f"expected one new SharePoint snapshot, found {len(added)}"
    assert drive_extras.sole_segment(s3, settings.bucket, "sharepoint") == site

    result = cli.ok("sharepoint", "list-permissions", "--site", settings.sharepoint_site)
    assert STATE["first"].name in result.out, result.describe()
    cli.ok("sharepoint", "list-snapshots", "--site", settings.sharepoint_site)


def test_03_restore_without_the_flag_shares_nothing(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """Sharing is opt-in on SharePoint too: a plain restore brings the bytes back, no link."""
    destination = f"/{drive.fixture_folder(run_marker)}/sp-restored-unshared"
    _restore(cli, settings, s3, destination)

    restored = f"{destination}{STATE['first'].path}"
    assert drive.file_sha256(graph, STATE["drive_id"], restored) == STATE["first"].sha256
    assert drive.sharing_links(graph, STATE["drive_id"], restored) == [], (
        "a restore without --restore-permissions shared the restored file"
    )


def test_04_restore_permissions_recreates_the_link(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`--restore-permissions` gives the restored library file a link of the same type and scope.

    The run must still exit 0 when the item also carried grants that cannot be re-sent, such as a
    SharePoint site group: those are tallied as skipped, never as errors
    (`sharing-restore-tally.ts:19-22`, `sharing-restore-presenter.tsx:27-31`).
    """
    destination = f"/{drive.fixture_folder(run_marker)}/sp-restored-shared"
    _restore(cli, settings, s3, destination, "--restore-permissions")

    restored = f"{destination}{STATE['first'].path}"
    assert drive.file_sha256(graph, STATE["drive_id"], restored) == STATE["first"].sha256
    assert ORGANIZATION_VIEW_LINK in drive.sharing_links(graph, STATE["drive_id"], restored), (
        "the organization link was not recreated on the restored file"
    )


def test_05_target_site_writes_into_the_source_library(
    cli: Cli, graph: Any, settings: Settings, s3: Any, run_marker: str
) -> None:
    """`--target-site` resolves through Graph and lands the file in the library it came from.

    The target is resolved by `connector.resolve_site` (`command.handlers.tsx:242-248`). Whether the
    service then treats it as the source site or routes by library name (`restore.service.ts:118`,
    `entry-routing.ts:21-49`), the only library named like the source one is the default library,
    so that is where the bytes must be.
    """
    destination = f"/{drive.fixture_folder(run_marker)}/sp-restored-target"
    _restore(cli, settings, s3, destination, "--target-site", settings.sharepoint_site)

    restored = f"{destination}{STATE['first'].path}"
    assert drive.file_sha256(graph, STATE["drive_id"], restored) == STATE["first"].sha256


def test_06_a_second_version_is_backed_up(cli: Cli, graph: Any, settings: Settings) -> None:
    """Overwrites the file with new bytes, a clear interval after the first version.

    The wait makes the cutoff in the next test unambiguous: Graph reports modification times to the
    second, and the rollback picks versions by that time (`version-selection.ts:28-30`).
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

    _backup(cli, settings)
    cli.ok(
        "sharepoint", "list-versions", "--site", settings.sharepoint_site, "-f", STATE["first"].path
    )


def test_07_restore_version_writes_the_earlier_bytes_beside_the_file(
    cli: Cli, graph: Any, settings: Settings
) -> None:
    """`sharepoint restore-version --before` rolls the folder back without touching the live file.

    The cutoff sits two seconds after the first version and before the second, so the rollback has
    to choose the older of two stored versions. A copy is uploaded with conflict `fail` beside the
    original (`version-restore.ts:273-277`), so the live file must still hold the second version.
    """
    first_modified = parse_graph_time(STATE["first_modified"])
    assert first_modified is not None, "Graph returned no modification time for the first version"
    cutoff = (first_modified + timedelta(seconds=2)).strftime("%Y-%m-%dT%H:%M:%SZ")

    cli.ok(
        "sharepoint",
        "restore-version",
        "--site",
        settings.sharepoint_site,
        "--before",
        cutoff,
        "--path",
        f"/{STATE['folder']}",
    )

    digests = drive_extras.folder_digests(graph, STATE["drive_id"], STATE["folder"])
    assert STATE["first"].sha256 in digests.values(), (
        f"no sibling holds the first version: {digests}"
    )
    assert digests.get(STATE["first"].name) == STATE["second"].sha256, (
        "the rollback overwrote the live file without --in-place"
    )


def _backup(cli: Cli, settings: Settings) -> None:
    """Backs up the site with the arguments `test_30` used, so the delta cursor is resumed."""
    cli.ok("sharepoint", "backup", "--site", settings.sharepoint_site)


def _restore(cli: Cli, settings: Settings, s3: Any, destination: str, *flags: str) -> None:
    """Restores the shared file alone from the newest snapshot, under `destination`.

    `--file-filter` takes several values, so it goes last.
    """
    snapshot = drive_extras.newest_snapshot(s3, settings.bucket, STATE["site"], "sharepoint")
    cli.ok(
        "sharepoint",
        "restore",
        "--site",
        settings.sharepoint_site,
        "-s",
        snapshot,
        "-c",
        "rename",
        "--destination",
        destination,
        *flags,
        "--file-filter",
        STATE["first"].path,
    )
