"""Exit codes the CLI assigns, and the bucket views the exit-code and deletion suites compare.

The numbers mirror `ATLAS_EXIT_CODES` in `packages/cli/src/fatal-error.ts`. Scheduled jobs branch on
them, so a suite asserts the number and never the message.
"""

from __future__ import annotations

import re
from typing import Any

from atlas_e2e import storage
from atlas_e2e.config import Settings

EXIT_FAILURE = 1
EXIT_AUTH_DENIED = 4
EXIT_WRONG_PASSPHRASE = 5
EXIT_CONFIG_INVALID = 6
EXIT_NOT_FOUND = 7
EXIT_SNAPSHOT_NOT_NEWEST = 11

# Lease objects, from `owner_lease_key` in `packages/core/src/services/lease/owner-lease-key.ts`.
# Every command that takes a lease writes one and deletes it again, so a refused delete still
# leaves a lease version and a delete marker behind. Whole-bucket comparisons leave them out.
_LEASE_KEY = re.compile(
    r"^(?:_meta/tenant-lease\.json"
    r"|_meta/outlook-leases/[^/]+\.json"
    r"|[a-z]+/_meta/[^/]+/lease\.json)$"
)

# The second content prefix of each people workload, from `contacts_mailbox_prefixes` and
# `calendar_mailbox_prefixes` in each package's `services/shared/storage-keys.ts`.
_PEOPLE_CONTENT = {"contacts": "photos", "calendar": "attachments"}


def wrong(value: str) -> str:
    """A wrong value derived from a real one, so the scrubber's literal rule still redacts it."""
    return f"{value}-wrong"


def is_lease_key(key: str) -> bool:
    """Whether a key is an owner or tenant lease object."""
    return _LEASE_KEY.match(key) is not None


def durable_keys(s3: Any, bucket: str) -> list[str]:
    """Current keys without lease objects: what a refused command must leave exactly as it was."""
    return [key for key in storage.list_keys(s3, bucket) if not is_lease_key(key)]


def manifest_keys(s3: Any, bucket: str) -> list[str]:
    """Every snapshot manifest of every workload: the bucket's snapshot set."""
    return sorted(
        key
        for prefix in storage.MANIFEST_PREFIXES.values()
        for key in storage.list_keys(s3, bucket, prefix)
    )


def versions_under(s3: Any, bucket: str, prefix: str) -> list[tuple[str, str]]:
    """Every version and delete marker under a prefix, as (key, version id)."""
    entries: list[tuple[str, str]] = []
    for page in s3.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=prefix):
        for entry in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]:
            entries.append((entry["Key"], entry["VersionId"]))
    return sorted(entries)


def keys_oldest_first(s3: Any, bucket: str, prefix: str) -> list[str]:
    """Current keys under a prefix, ordered by when S3 stored them.

    An Outlook snapshot id is a UUID, so its key says nothing about its age. Its manifest is written
    create-only, once, at the end of its run, and runs of one mailbox are serialised by the owner
    lease, so the write order is the snapshot order without decrypting anything.
    """
    stamped: list[tuple[Any, str]] = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        stamped.extend((obj["LastModified"], obj["Key"]) for obj in page.get("Contents", []))
    return [key for _, key in sorted(stamped)]


def snapshot_id_of(manifest_key: str) -> str:
    """The snapshot id a manifest key names: its last segment without `.json`."""
    return manifest_key.rsplit("/", 1)[-1].removesuffix(".json")


def people_scopes(workload: str, segment: str) -> list[str]:
    """Every prefix `<workload> delete -m` erases for one mailbox segment."""
    return [
        f"{workload}/data/{segment}/",
        f"{workload}/{_PEOPLE_CONTENT[workload]}/{segment}/",
        f"{workload}/manifests/{segment}/",
        f"{workload}/_meta/{segment}/",
        f"_quarantine/{workload}/manifests/{segment}/",
    ]


def verify_commands(settings: Settings, s3: Any) -> dict[str, tuple[str, ...]]:
    """One full `verify` per workload that holds a snapshot, keyed by workload.

    `verify` is the read command every workload has, and each one opens the tenant key before it
    reads anything else, so it is the narrowest command that proves the passphrase is checked.
    """
    owner_flags = {
        "outlook": ("-m", settings.mailbox),
        "contacts": ("-m", settings.mailbox),
        "calendar": ("-m", settings.mailbox),
        "onedrive": ("-o", settings.onedrive_owner),
        "sharepoint": ("--site", settings.sharepoint_site),
        "teams": ("--team", settings.team_id),
    }
    commands: dict[str, tuple[str, ...]] = {}
    for workload, (flag, value) in owner_flags.items():
        segments = storage.owner_segments(s3, settings.bucket, workload)
        if not value or not segments:
            continue
        snapshots = storage.snapshot_ids(s3, settings.bucket, segments[0], workload)
        if snapshots:
            commands[workload] = (workload, "verify", flag, value, "-s", snapshots[0])
    return commands
