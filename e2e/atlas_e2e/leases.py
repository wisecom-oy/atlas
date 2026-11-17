"""Run leases written straight into the bucket, so a test can hold an owner without a race.

A lease is one plaintext JSON object per owner, mirrored here from
`packages/core/src/services/lease/owner-lease-key.ts` (keys) and `owner-lease-record.ts` (body).
Writing one directly is how the suite makes "another operation is running" deterministic: two real
commands started together would decide the outcome by timing.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from botocore.exceptions import ClientError

from atlas_e2e import storage

OUTLOOK_LEASE_PREFIX = "_meta/outlook-leases/"
TENANT_LEASE_KEY = "_meta/tenant-lease.json"
# Every workload but Outlook keeps an owner's lease in that owner's own `_meta` directory.
OWNER_LEASE_WORKLOADS = ("onedrive", "sharepoint", "contacts", "calendar", "teams")
LEASE_FORMAT_VERSION = 1

# Far past the CLI's own run time, so a lease written as live stays live for the whole command.
LIVE = timedelta(minutes=30)
EXPIRED = timedelta(minutes=-30)


def outlook_lease_key(owner: str) -> str:
    """Key of a mailbox's lease: Outlook keeps its metadata at the bucket root."""
    return f"{OUTLOOK_LEASE_PREFIX}{owner}.json"


def lease_body(
    holder: str,
    operation: str,
    expires_in: timedelta,
    *,
    released: bool = False,
    format_version: int = LEASE_FORMAT_VERSION,
) -> bytes:
    """A lease record as another run would have written it, expiring `expires_in` from now."""
    now = datetime.now(UTC)
    record: dict[str, Any] = {
        "format_version": format_version,
        "holder_id": holder,
        "operation": operation,
        "acquired_at": _iso(now),
        "expires_at": _iso(now + expires_in),
    }
    if released:
        record["released_at"] = _iso(now)
    return json.dumps(record).encode("utf-8")


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@contextmanager
def foreign_lease(s3: Any, bucket: str, key: str, body: bytes) -> Iterator[None]:
    """Holds `key` with `body` for the duration, then removes exactly the version it wrote.

    Refuses to start over a lease that is already stored: overwriting it would hide a real run, or
    a lease an earlier step failed to release. Removing the written version by id, rather than
    deleting the key, leaves the key's history as Atlas left it, whether or not the command under
    test took the lease over in between.
    """
    assert not object_exists(s3, bucket, key), f"a lease is already stored at {key}"
    response = s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json")
    try:
        yield
    finally:
        version = response.get("VersionId")
        if version and version != "null":
            s3.delete_object(Bucket=bucket, Key=key, VersionId=version)
        else:
            s3.delete_object(Bucket=bucket, Key=key)


def object_exists(s3: Any, bucket: str, key: str) -> bool:
    """Whether a current object is stored at `key`. A delete marker reads as absent."""
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise
    return True


def read_object(s3: Any, bucket: str, key: str) -> bytes:
    """The current bytes at `key`."""
    body: bytes = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return body


def stored_lease_keys(s3: Any, bucket: str) -> list[str]:
    """Every lease object currently stored in the tenant bucket, owner and tenant alike."""
    keys = storage.list_keys(s3, bucket, OUTLOOK_LEASE_PREFIX)
    for workload in OWNER_LEASE_WORKLOADS:
        keys += [
            key
            for key in storage.list_keys(s3, bucket, f"{workload}/_meta/")
            if key.endswith("/lease.json")
        ]
    if object_exists(s3, bucket, TENANT_LEASE_KEY):
        keys.append(TENANT_LEASE_KEY)
    return keys


def manifests_oldest_first(s3: Any, bucket: str, prefix: str) -> list[str]:
    """Snapshot ids under a manifest prefix, ordered by when their manifest was written.

    Outlook snapshot ids are UUIDs and the manifest's own time is inside its ciphertext, so the
    write time S3 recorded is the only order readable without the key. Runs in this suite are
    sequential, so it matches the order of the runs.
    """
    objects: list[tuple[datetime, str]] = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        objects.extend((obj["LastModified"], obj["Key"]) for obj in page.get("Contents", []))
    return [key[len(prefix) : -len(".json")] for _, key in sorted(objects) if key.endswith(".json")]
