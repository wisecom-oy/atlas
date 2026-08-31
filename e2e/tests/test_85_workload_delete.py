"""Per-workload deletion, asserted after every workload suite and before the tenant purge.

Wired to the CLI by issue #163: the OneDrive and SharePoint deletion services existed, were tested,
and only the SDK could reach them.

Deliberately snapshot-scoped rather than owner- or site-scoped. A snapshot delete removes exactly
one manifest and retains the content-addressed blobs, which is the property worth asserting here,
and it leaves the drive prefixes populated so `test_90_purge` still proves the cross-workload sweep
it claims to. The owner and site scopes are covered by the CLI unit suite, which can assert the
use-case call without erasing a live tenant's backup.

Runs after replication (`test_40`), which destroys the primary bucket and rehydrates it from the
replica. The drive snapshots asserted here are therefore the rehydrated copies, which makes this a
stronger check than it looks: it only passes if the drives survived the whole replicate, purge and
rehydrate loop. That is exactly what failed before issue #210, when `test_40` replicated the mailbox
alone and the drives never came back.
"""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings


def test_01_onedrive_snapshot_delete_keeps_the_blobs(cli: Cli, settings: Settings, s3: Any) -> None:
    """`onedrive delete -o -s` drops one manifest, retains data objects, spares other workloads."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")

    owner = _single_segment(s3, settings.bucket, "onedrive/manifests/")
    snapshots = storage.snapshot_ids(s3, settings.bucket, owner, "onedrive")
    assert snapshots, "no OneDrive snapshot to delete"

    data_before = storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/")
    sharepoint_before = storage.list_keys(s3, settings.bucket, "sharepoint/")
    outlook_before = storage.list_keys(s3, settings.bucket, "outlook/")

    cli.ok("onedrive", "delete", "-o", settings.onedrive_owner, "-s", snapshots[0], "-y")

    remaining = storage.snapshot_ids(s3, settings.bucket, owner, "onedrive")
    assert snapshots[0] not in remaining, "the deleted OneDrive snapshot is still listed"
    assert storage.list_keys(s3, settings.bucket, f"onedrive/data/{owner}/") == data_before, (
        "a snapshot delete removed content-addressed blobs other snapshots may reference"
    )
    assert storage.list_keys(s3, settings.bucket, "sharepoint/") == sharepoint_before, (
        "a OneDrive-scoped delete touched SharePoint objects"
    )
    assert storage.list_keys(s3, settings.bucket, "outlook/") == outlook_before, (
        "a OneDrive-scoped delete touched Outlook objects"
    )


def test_02_sharepoint_snapshot_delete_keeps_the_blobs(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """`sharepoint delete --site -s` drops one manifest and spares the other workloads."""
    if not settings.sharepoint_site:
        pytest.skip("E2E_SHAREPOINT_SITE not set")

    site = _single_segment(s3, settings.bucket, "sharepoint/manifests/")
    snapshots = storage.snapshot_ids(s3, settings.bucket, site, "sharepoint")
    assert snapshots, "no SharePoint snapshot to delete"

    data_before = storage.list_keys(s3, settings.bucket, f"sharepoint/data/{site}/")
    onedrive_before = storage.list_keys(s3, settings.bucket, "onedrive/")
    outlook_before = storage.list_keys(s3, settings.bucket, "outlook/")

    cli.ok("sharepoint", "delete", "--site", settings.sharepoint_site, "-s", snapshots[0], "-y")

    remaining = storage.snapshot_ids(s3, settings.bucket, site, "sharepoint")
    assert snapshots[0] not in remaining, "the deleted SharePoint snapshot is still listed"
    assert storage.list_keys(s3, settings.bucket, f"sharepoint/data/{site}/") == data_before, (
        "a snapshot delete removed content-addressed blobs other snapshots may reference"
    )
    assert storage.list_keys(s3, settings.bucket, "onedrive/") == onedrive_before, (
        "a SharePoint-scoped delete touched OneDrive objects"
    )
    assert storage.list_keys(s3, settings.bucket, "outlook/") == outlook_before, (
        "a SharePoint-scoped delete touched Outlook objects"
    )


def _single_segment(s3: Any, bucket: str, prefix: str) -> str:
    """Reads the one owner or site segment Atlas wrote under a manifests prefix."""
    segments = {key.split("/")[2] for key in storage.list_keys(s3, bucket, prefix)}
    assert len(segments) == 1, (
        f"expected exactly one segment under {prefix}, found {sorted(segments)}"
    )
    return segments.pop()
