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

from atlas_e2e.graph import Graph

log = logging.getLogger(__name__)

FIXTURE_BYTES = 4096


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


def seed_fixture_file(graph: Graph, drive_id: str, marker: str, versions: int = 1) -> SeededFile:
    """Seeds `<marker>/<marker>-file.bin` with `versions` successive versions; returns the newest."""
    seeded: SeededFile | None = None
    for _ in range(versions):
        seeded = upload_file(graph, drive_id, marker, f"{marker}-file.bin", os.urandom(FIXTURE_BYTES))
    assert seeded is not None
    return seeded


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
    if response.status_code >= 400:
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
        return list(graph.paged(f"/drives/{drive_id}/root:/{folder}:/children", **{"$select": "id,name"}))
    except Exception:  # noqa: BLE001 - absent folder is a normal outcome for a probe
        return []


def marked_root_folders(graph: Graph, drive_id: str, prefix: str) -> list[dict[str, Any]]:
    """Root-level folders whose name carries an E2E marker; the cleanup target set."""
    items = graph.paged(f"/drives/{drive_id}/root/children", **{"$select": "id,name,createdDateTime"})
    return [i for i in items if str(i.get("name", "")).startswith(prefix)]
