"""Drive probes and CLI calls the selection and SharePoint sharing suites need beyond `drive.py`.

Kept apart from `drive.py` so the lifecycle helpers stay as they are. The probes create and delete
nothing in Microsoft 365; the CLI wrappers only fix the arguments every OneDrive call here repeats.
"""

from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path
from typing import Any

from atlas_e2e import drive, storage
from atlas_e2e.atlas import WHOLE_DRIVE_TIMEOUT, Cli, Result
from atlas_e2e.graph import HTTP_ERROR_FLOOR, Graph


def onedrive_scoped_backup(cli: Cli, owner: str, marker: str) -> None:
    """Backs up the run's fixture folder with the `--folder` scope `test_20` set up.

    Any other scope discards the stored delta link and lists the whole drive again.
    """
    cli.ok(
        "onedrive",
        "backup",
        "-o",
        owner,
        "--folder",
        f"/{drive.fixture_folder(marker)}",
        timeout=WHOLE_DRIVE_TIMEOUT,
    )


def assert_exit(result: Result, code: int) -> None:
    """Asserts a CLI exit code, with the scrubbed command and output on failure."""
    assert result.code == code, result.describe()


def onedrive_restore(cli: Cli, owner: str, snapshot: str, *args: str) -> Result:
    """Runs `onedrive restore` on one snapshot without asserting the exit code.

    `--file-filter` is variadic, so a caller passes it last in `args`.
    """
    return cli.run(
        "onedrive", "restore", "-o", owner, "-s", snapshot, *args, timeout=WHOLE_DRIVE_TIMEOUT
    )


def onedrive_save(cli: Cli, owner: str, snapshot: str, archive: Path, *filters: str) -> Result:
    """Runs `onedrive save --file-filter <filters>` into `archive`, without asserting the exit."""
    return cli.run(
        "onedrive",
        "save",
        "-o",
        owner,
        "-s",
        snapshot,
        "--output",
        str(archive),
        "--file-filter",
        *filters,
        timeout=WHOLE_DRIVE_TIMEOUT,
    )


def item_exists(graph: Graph, drive_id: str, path: str) -> bool:
    """Whether a drive item, file or folder, exists at a drive-root-relative path.

    Distinguishes an absent folder from an empty one, which `drive.children` cannot: a restore that
    must fail before any write is proven by its destination folder never being created.
    """
    response = graph.request("GET", f"/drives/{drive_id}/root:{path}")
    return response.status_code < HTTP_ERROR_FLOOR


def folder_digests(graph: Graph, drive_id: str, folder: str) -> dict[str, str | None]:
    """SHA-256 of every direct child of a folder, keyed by name. Empty when the folder is absent."""
    rooted = f"/{folder.strip('/')}"
    return {
        str(item["name"]): drive.file_sha256(graph, drive_id, f"{rooted}/{item['name']}")
        for item in drive.children(graph, drive_id, rooted.lstrip("/"))
    }


def sole_segment(s3: Any, bucket: str, workload: str) -> str:
    """The one owner or site segment holding manifests for a drive workload.

    Read from the key names, as the lifecycle suites do, so the suite never repeats Atlas's own
    normalisation of an address or a composite site id.
    """
    segments = storage.owner_segments(s3, bucket, workload)
    assert len(segments) == 1, f"expected one backed-up {workload} segment, found {len(segments)}"
    return segments[0]


def newest_snapshot(s3: Any, bucket: str, segment: str, workload: str) -> str:
    """The newest snapshot of a segment. Snapshot ids embed their creation time in milliseconds."""
    snapshots = storage.snapshot_ids(s3, bucket, segment, workload)
    assert snapshots, f"no {workload} snapshot stored"
    return snapshots[-1]


def zip_file_digests(archive: Path) -> dict[str, str]:
    """SHA-256 of every file entry in a zip, keyed by entry name. Directory entries are left out."""
    with zipfile.ZipFile(archive) as zf:
        return {
            name: hashlib.sha256(zf.read(name)).hexdigest()
            for name in zf.namelist()
            if not name.endswith("/")
        }
