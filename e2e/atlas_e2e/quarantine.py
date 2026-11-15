"""Damaging a stored manifest and rolling the bucket back afterwards, version by version.

Quarantine moves objects, and the later suites need every snapshot where it was. The tenant bucket
is versioned, so every write a test makes, or a command it runs makes, is one new version or delete
marker. Removing exactly those by version id returns the bucket to the versions it held before,
byte for byte and with the same version ids, which re-uploading saved bytes could not do.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from atlas_e2e.config import Settings

QUARANTINE_PREFIX = "_quarantine/"

Version = tuple[str, str]


@dataclass(frozen=True)
class QuarantineCase:
    """One workload: its storage name, and the listing that has to decrypt its manifests."""

    workload: str
    configured: Callable[[Settings], bool]
    list_args: Callable[[Settings], tuple[str, ...]]

    def summary_key(self, owner: str) -> str:
        """The owner's snapshot summary index, which listings answer from instead of manifests.

        Mirrored from `outlook_summary_key` in `packages/s3` and the `snapshot_summary_key` and
        `*_summary_key` helpers of the other workloads.
        """
        if self.workload == "outlook":
            return f"_meta/outlook-manifests/owners/{owner}/summary.json"
        return f"{self.workload}/_meta/{owner}/snapshots.json"


CASES = (
    QuarantineCase("outlook", lambda s: True, lambda s: ("outlook", "list", "-m", s.mailbox)),
    QuarantineCase(
        "onedrive",
        lambda s: bool(s.onedrive_owner),
        lambda s: ("onedrive", "list-snapshots", "-o", s.onedrive_owner),
    ),
    QuarantineCase(
        "sharepoint",
        lambda s: bool(s.sharepoint_site),
        lambda s: ("sharepoint", "list-snapshots", "--site", s.sharepoint_site),
    ),
    QuarantineCase("contacts", lambda s: True, lambda s: ("contacts", "list", "-m", s.mailbox)),
    QuarantineCase("calendar", lambda s: True, lambda s: ("calendar", "list", "-m", s.mailbox)),
)


def damaged(ciphertext: bytes) -> bytes:
    """The same object with its last byte flipped: intact in shape, failing AES-GCM authentication.

    The envelope header stays as it was, so the object reads as a damaged current-format object and
    never as one a newer Atlas wrote, which quarantine would refuse.
    """
    flipped = bytearray(ciphertext)
    flipped[-1] ^= 0x01
    return bytes(flipped)


def bucket_versions(s3: Any, bucket: str) -> set[Version]:
    """Every object version and delete marker in the bucket, as (key, version id)."""
    versions: set[Version] = set()
    for page in s3.get_paginator("list_object_versions").paginate(Bucket=bucket):
        for entry in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]:
            versions.add((entry["Key"], entry["VersionId"]))
    return versions


def roll_back_to(s3: Any, bucket: str, before: set[Version]) -> list[Version]:
    """Removes every version and delete marker written since `before` was listed.

    Returns the versions that were in `before` and are gone now. Rolling back cannot recover those,
    so a caller asserts the list is empty.
    """
    now = bucket_versions(s3, bucket)
    for key, version in sorted(now - before):
        s3.delete_object(Bucket=bucket, Key=key, VersionId=version)
    return sorted(before - now)


def versioning_enabled(s3: Any, bucket: str) -> bool:
    """Whether the bucket keeps versions, which the rollback depends on."""
    status: str | None = s3.get_bucket_versioning(Bucket=bucket).get("Status")
    return status == "Enabled"
