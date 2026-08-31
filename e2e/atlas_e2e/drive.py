"""Drive fixtures for OneDrive and SharePoint: same Graph shape, different drive resolution.

Both workloads back up `driveItem`s, so seeding, reading back, and hashing are identical once the
drive id is known. Only how the drive is found differs -- a user's default drive versus a site's.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

from atlas_e2e.graph import HTTP_ERROR_FLOOR, Graph, GraphError

log = logging.getLogger(__name__)

FIXTURE_BYTES = 4096
# Crosses the 4 MB thresholds the product changes behaviour at: chunked download
# (CHUNK_DOWNLOAD_THRESHOLD), streaming restore (STREAM_THRESHOLD_BYTES / SMALL_FILE_LIMIT), and
# Graph's own simple-upload cap. Issue #143 broke every one of those and the suite stayed green.
# ponytail: one size, not a matrix. 12 MB (LARGE_UPLOAD_CHUNK) and 64 MB (HASH_CHUNK_SIZE) belong
# in an opt-in dispatch suite, not a nightly that pays real Graph quota for them.
LARGE_FIXTURE_BYTES = 5 * 1024 * 1024

# Every fixture the suite creates lives under one drive-root folder, so an operator has a single
# place to look and a single thing to delete, and so a scoped backup (`--folder`) never has to
# enumerate the account's real content. Nested per run: `E2E/atlas-e2e-<run-id>/...`.
FIXTURE_ROOT = "E2E"


@dataclass(frozen=True)
class SeededFile:
    """A file the suite uploaded, plus the hash a restore must reproduce."""

    item_id: str
    name: str
    folder: str
    sha256: str

    @property
    def path(self) -> str:
        """Drive-root-relative path, the form `--file-filter` and `list-versions` accept."""
        return f"/{self.folder}/{self.name}"


def user_drive_id(graph: Graph, owner: str) -> str:
    """The owner's default OneDrive id."""
    return str(graph.get(f"/users/{owner}/drive", **{"$select": "id"})["id"])


def site_id(graph: Graph, site_url: str) -> str:
    """Resolves a site URL to its composite Graph site id (`hostname,siteGuid,webGuid`)."""
    host, _, path = site_url.replace("https://", "").partition("/")
    return str(graph.get(f"/sites/{host}:/{path}", **{"$select": "id"})["id"])


def site_drive_id(graph: Graph, site: str) -> str:
    """The site's default document library id."""
    return str(graph.get(f"/sites/{site}/drive", **{"$select": "id"})["id"])


def upload_file(graph: Graph, drive_id: str, folder: str, name: str, content: bytes) -> SeededFile:
    """Uploads (or overwrites) a file under `folder`, creating the folder implicitly.

    A second upload of the same path creates a new **version** of the same item, which is what the
    version-index assertion needs -- `PUT .../content` on an existing path never forks a new item.
    """
    item = graph.call(
        "PUT",
        f"/drives/{drive_id}/root:/{folder}/{name}:/content",
        content=content,
        headers={"Content-Type": "application/octet-stream"},
    )
    return SeededFile(
        item_id=str(item["id"]),
        name=name,
        folder=folder,
        sha256=hashlib.sha256(content).hexdigest(),
    )


def fixture_folder(marker: str) -> str:
    """This run's fixture folder, `E2E/<marker>`, relative to the drive root."""
    return f"{FIXTURE_ROOT}/{marker}"


def restore_destination(marker: str) -> str:
    """Where this run sends restore output.

    Issue #217 made a drive restore nest under a generated `Restore-<timestamp>` root at the drive
    root. That is the right default for an operator, but it sits outside the marker namespace the
    suite owns, and cleanup must never delete outside it, so the suite restores into its own fixture
    folder instead and asserts the nesting there.
    """
    return f"/{fixture_folder(marker)}/restored"


def restored_tree(marker: str) -> str:
    """Restored files keep their original nesting beneath the destination."""
    return f"{restore_destination(marker)}/{fixture_folder(marker)}"


def ensure_fixture_folder(graph: Graph, drive_id: str, marker: str) -> None:
    """Creates `E2E/<marker>`, and `E2E` itself when the drive has no fixture root yet.

    Uploading by path only creates the immediate parent, so a two-level fixture path needs the
    intermediate folder to exist. Both creates tolerate a folder that is already there.
    """
    for parent, name in (("root", FIXTURE_ROOT), (f"root:/{FIXTURE_ROOT}:", marker)):
        try:
            graph.post(
                f"/drives/{drive_id}/{parent}/children",
                {"name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"},
            )
        except GraphError as err:
            log.debug("Fixture folder %s already present or not creatable: %s", name, err)


def seed_fixture_file(graph: Graph, drive_id: str, marker: str, versions: int = 1) -> SeededFile:
    """Seeds `E2E/<marker>/<marker>-file.bin` with `versions` versions; newest returned."""
    ensure_fixture_folder(graph, drive_id, marker)
    folder = fixture_folder(marker)
    seeded: SeededFile | None = None
    for _ in range(versions):
        seeded = upload_file(
            graph, drive_id, folder, f"{marker}-file.bin", os.urandom(FIXTURE_BYTES)
        )
    assert seeded is not None
    return seeded


def upload_large_file(
    graph: Graph, drive_id: str, folder: str, name: str, content: bytes
) -> SeededFile:
    """Uploads a file above Graph's 4 MB simple-upload cap through an upload session.

    Any fixture that crosses the product's 4 MB thresholds also crosses Graph's own, so
    `PUT .../content` cannot seed it. One final-range PUT is enough here: the 320 KiB fragment rule
    binds intermediate chunks only, and the 60 MiB per-request ceiling is far above this size.
    The upload URL is pre-authenticated, so it is called without the bearer token.
    """
    session = graph.post(
        f"/drives/{drive_id}/root:/{folder}/{name}:/createUploadSession",
        {"item": {"@microsoft.graph.conflictBehavior": "replace"}},
    )
    total = len(content)
    response = httpx.put(
        str(session["uploadUrl"]),
        content=content,
        timeout=300.0,
        headers={"Content-Range": f"bytes 0-{total - 1}/{total}"},
    )
    if response.status_code not in (200, 201):
        raise GraphError(f"upload session PUT {name} -> {response.status_code}")
    return SeededFile(
        item_id=str(response.json()["id"]),
        name=name,
        folder=folder,
        sha256=hashlib.sha256(content).hexdigest(),
    )


def seed_large_fixture_file(graph: Graph, drive_id: str, marker: str) -> SeededFile:
    """Seeds `E2E/<marker>/<marker>-large.bin` at 5 MB, above every 4 MB code path."""
    ensure_fixture_folder(graph, drive_id, marker)
    return upload_large_file(
        graph,
        drive_id,
        fixture_folder(marker),
        f"{marker}-large.bin",
        os.urandom(LARGE_FIXTURE_BYTES),
    )


def read_file(graph: Graph, drive_id: str, path: str) -> bytes | None:
    """Downloads a drive item's bytes by path, or None when it is absent.

    Uses the item's `@microsoft.graph.downloadUrl` rather than following the `/content` redirect:
    the redirect target is a pre-authenticated storage URL, so the bearer token must not be sent
    with it.

    No `$select`: OData annotations are not selectable alongside ordinary properties on every drive
    implementation, and asking for one returned 400 rather than the item (run 32136234300). The full
    item is a few hundred bytes.
    """
    response = graph.request("GET", f"/drives/{drive_id}/root:{path}")
    if response.status_code >= HTTP_ERROR_FLOOR:
        log.info("Drive item %s unavailable: HTTP %s", path, response.status_code)
        return None
    url = response.json().get("@microsoft.graph.downloadUrl")
    if not url:
        log.info("Drive item %s carries no download URL", path)
        return None
    return httpx.get(url, timeout=60.0, follow_redirects=True).content


def file_sha256(graph: Graph, drive_id: str, path: str) -> str | None:
    """SHA-256 of a drive item's content, or None when the item is missing."""
    content = read_file(graph, drive_id, path)
    return hashlib.sha256(content).hexdigest() if content is not None else None


def delete_item(graph: Graph, drive_id: str, item_id: str) -> None:
    """Removes a drive item so a restore has something to prove."""
    graph.delete(f"/drives/{drive_id}/items/{item_id}")


def children(graph: Graph, drive_id: str, folder: str) -> list[dict[str, Any]]:
    """Direct children of a drive folder; empty when the folder does not exist."""
    try:
        return list(
            graph.paged(f"/drives/{drive_id}/root:/{folder}:/children", **{"$select": "id,name"})
        )
    except Exception:  # noqa: BLE001 - absent folder is a normal outcome for a probe
        return []


def fixture_items(graph: Graph, drive_id: str, prefix: str) -> list[dict[str, Any]]:
    """Marker-named folders cleanup may delete, from the fixture root and from the drive root.

    Both locations are filtered by the marker prefix. Returning unfiltered children of the fixture
    root once deleted a tenant's real files: the folder is suite-owned by convention only, and a
    convention is not a safe basis for deletion. The drive root is still scanned because runs before
    the fixture root existed seeded there, and because SharePoint libraries may hold that layout.
    """
    select = {"$select": "id,name,createdDateTime"}
    marked: list[dict[str, Any]] = []
    for path in (
        f"/drives/{drive_id}/root:/{FIXTURE_ROOT}:/children",
        f"/drives/{drive_id}/root/children",
    ):
        try:
            marked.extend(
                i for i in graph.paged(path, **select) if str(i.get("name", "")).startswith(prefix)
            )
        except GraphError as err:
            log.debug("Could not list %s: %s", path, err)
    return marked


def restore_roots_containing(graph: Graph, drive_id: str, marker: str) -> list[dict[str, Any]]:
    """Drive-root `Restore-*` folders holding this run's fixture tree.

    A restore that takes the default destination writes `/Restore-<timestamp>/E2E/<marker>/...` at
    the drive root, outside the marker namespace `fixture_items` scans, so nothing deleted it and
    every nightly run left an empty tree behind. The root carries no marker of ours, so ownership is
    decided by a marked child, never by the name alone: an operator's own restore must survive.
    """
    roots: list[dict[str, Any]] = []
    try:
        top = list(graph.paged(f"/drives/{drive_id}/root/children", **{"$select": "id,name"}))
    except GraphError as err:
        log.debug("Could not list drive root: %s", err)
        return roots
    for item in top:
        name = str(item.get("name", ""))
        if not name.startswith("Restore-"):
            continue
        inner = children(graph, drive_id, f"{name}/{FIXTURE_ROOT}")
        if any(marker in str(c.get("name", "")) for c in inner):
            roots.append(item)
    return roots
