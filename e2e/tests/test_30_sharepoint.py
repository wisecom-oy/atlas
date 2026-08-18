"""SharePoint lifecycle, plus the `--site` identifier-form guard from issue #90.

SharePoint backup is site-targeted rather than user-targeted, so the identifier is the whole story:
a URL, a `hostname:/sites/name` short form, and a composite `hostname,siteGuid,webGuid` id must all
address the same tree.
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
def _requires_site(settings: Settings) -> None:
    """Skips the whole module when no SharePoint site is configured."""
    if not settings.sharepoint_site:
        pytest.skip("E2E_SHAREPOINT_SITE not set")


def test_01_seed_a_library_file(graph: Any, settings: Settings, run_marker: str) -> None:
    """Uploads the fixture file into the site's default document library."""
    composite_id = drive.site_id(graph, settings.sharepoint_site)
    STATE["composite_id"] = composite_id
    STATE["drive_id"] = drive.site_drive_id(graph, composite_id)
    STATE["file"] = drive.seed_fixture_file(graph, STATE["drive_id"], run_marker)

    assert drive.file_sha256(graph, STATE["drive_id"], STATE["file"].path) == STATE["file"].sha256


def test_02_list_sites_reaches_graph(cli: Cli) -> None:
    """`sharepoint list-sites` enumerates live sites, which is the resolution path backup uses."""
    cli.ok("sharepoint", "list-sites")


def test_03_backup_by_url_writes_objects(cli: Cli, settings: Settings, s3: Any) -> None:
    """Backs up the site addressed by browser URL and asserts objects landed under `sharepoint/`."""
    cli.ok("sharepoint", "backup", "--site", settings.sharepoint_site)

    site = _site_segment(s3, settings.bucket)
    STATE["site"] = site

    snapshots = storage.snapshot_ids(s3, settings.bucket, site, "sharepoint")
    assert len(snapshots) == 1, f"expected one SharePoint snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]

    assert storage.list_keys(s3, settings.bucket, f"sharepoint/data/{site}/"), "no file blob written"


def test_04_every_site_form_addresses_one_tree(cli: Cli, settings: Settings, s3: Any) -> None:
    """URL, `hostname:/sites/name`, and composite id must all resolve to the same stored tree.

    Regression guard for #90, where a raw URL reached the storage-key builder and failed with
    "Invalid storage key segment". A second accepted spelling would also mean a second prefix, so
    the assertion is that the manifest set is unchanged after listing through each form.
    """
    url = settings.sharepoint_site
    host, _, path = url.replace("https://", "").partition("/")
    forms = [url, f"{host}:/{path}", STATE["composite_id"]]

    before = storage.snapshot_ids(s3, settings.bucket, STATE["site"], "sharepoint")
    for form in forms:
        cli.ok("sharepoint", "list-snapshots", "--site", form)

    prefixes = {key.split("/")[2] for key in storage.list_keys(s3, settings.bucket, "sharepoint/manifests/")}
    assert prefixes == {STATE["site"]}, f"site forms produced more than one tree: {sorted(prefixes)}"
    assert storage.snapshot_ids(s3, settings.bucket, STATE["site"], "sharepoint") == before


def test_05_verify_passes(cli: Cli, settings: Settings) -> None:
    """Deep verification: every blob is downloaded, decrypted, re-hashed, compared."""
    cli.ok("sharepoint", "verify", "--site", settings.sharepoint_site, "-s", STATE["snapshot"])


def test_06_save_exports_the_file(cli: Cli, settings: Settings, exports: Path, run_marker: str) -> None:
    """`sharepoint save` writes a zip mirroring the library hierarchy."""
    archive = exports / f"{run_marker}-sharepoint.zip"
    cli.ok(
        "sharepoint",
        "save",
        "--site",
        settings.sharepoint_site,
        "-s",
        STATE["snapshot"],
        "-O",
        str(archive),
    )

    assert archive.exists(), f"{archive} was not written"
    with zipfile.ZipFile(archive) as zf:
        assert any(STATE["file"].name in n for n in zf.namelist()), zf.namelist()


def test_07_restore_recreates_a_deleted_file(cli: Cli, graph: Any, settings: Settings) -> None:
    """Deletes the file from the library and restores it from the snapshot."""
    file = STATE["file"]
    drive.delete_item(graph, STATE["drive_id"], file.item_id)
    assert drive.file_sha256(graph, STATE["drive_id"], file.path) is None, "file survived deletion"

    cli.ok(
        "sharepoint",
        "restore",
        "--site",
        settings.sharepoint_site,
        "-s",
        STATE["snapshot"],
        "-c",
        "rename",
    )


def test_08_restored_bytes_match_the_seed(graph: Any, run_marker: str) -> None:
    """The restored file hashes to the seeded bytes, read back through Graph."""
    restored = drive.children(graph, STATE["drive_id"], run_marker)
    assert restored, f"no files under /{run_marker} after restore"

    digests = {
        drive.file_sha256(graph, STATE["drive_id"], f"/{run_marker}/{item['name']}") for item in restored
    }
    assert STATE["file"].sha256 in digests, "no restored file matches the seeded bytes"


def _site_segment(s3: Any, bucket: str) -> str:
    """Reads the site segment Atlas used, rather than assuming how the composite id was normalised."""
    keys = storage.list_keys(s3, bucket, "sharepoint/manifests/")
    sites = {key.split("/")[2] for key in keys}
    assert len(sites) == 1, f"expected exactly one backed-up site, found {sorted(sites)}"
    return sites.pop()
