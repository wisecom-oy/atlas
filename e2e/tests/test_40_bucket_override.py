"""A copy of the tenant bucket under another name opens through the bucket override (issue #768).

AWS S3 and Backblaze B2 replicas cannot carry the primary's bucket name, so Atlas reads them through
`ATLAS_S3_BUCKET`. A second bucket in the same MinIO stands in for such a replica: the `bucket_copy`
fixture copies the primary into it and creates a user that may only read it.

Numbered 40: after the workload suites and `test_37`, so the primary holds every configured
workload's snapshots, and before `test_85` and `test_90`, which delete from it. The copy's own
version listing is the ground truth for "wrote nothing"; CLI output is not consulted.
"""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.minio_admin import ReadOnlyCopy

# A syntactically valid tenant the run's override was not configured for.
OTHER_TENANT = "00000000-0000-0000-0000-000000000000"

# Exit code for ATLAS_CONFIG_INVALID.
EXIT_CONFIG = 6

STATE: dict[str, Any] = {}


def _latest_snapshot(s3: Any, bucket: str, workload: str) -> str:
    """The newest snapshot of the one owner or site a workload suite backed up."""
    prefix = storage.MANIFEST_PREFIXES[workload]
    depth = prefix.count("/")
    owners = {key.split("/")[depth] for key in storage.list_keys(s3, bucket, prefix)}
    assert len(owners) == 1, f"expected one {workload} owner, found {len(owners)}"
    snapshots = storage.snapshot_ids(s3, bucket, owners.pop(), workload)
    assert snapshots, f"no {workload} snapshot on the primary"
    return snapshots[-1]


def test_01_the_copy_holds_the_primary_and_its_key(
    settings: Settings, s3: Any, bucket_copy: ReadOnlyCopy
) -> None:
    """The copy has every current object of the primary, the wrapped data key included."""
    primary = storage.list_keys(s3, settings.bucket)
    assert "_meta/dek.enc" in primary, "the primary holds no data key; earlier suites did not run"
    assert storage.list_keys(s3, bucket_copy.bucket) == primary

    STATE["buckets"] = storage.bucket_names(s3)
    STATE["listing"] = storage.version_listing(s3, bucket_copy.bucket)
    STATE["primary"] = storage.version_listing(s3, settings.bucket)


def test_02_outlook_verify_and_list_read_the_copy(
    cli: Cli, settings: Settings, s3: Any, bucket_copy: ReadOnlyCopy
) -> None:
    """Outlook verify downloads, decrypts and hashes from the copy; list reads its catalog."""
    snapshot = _latest_snapshot(s3, bucket_copy.bucket, "outlook")
    env = bucket_copy.cli_env()

    cli.ok("outlook", "verify", "-m", settings.mailbox, "-s", snapshot, extra_env=env)
    cli.ok("outlook", "list", "-m", settings.mailbox, extra_env=env)


def test_03_onedrive_verify_reads_the_copy(
    cli: Cli, settings: Settings, s3: Any, bucket_copy: ReadOnlyCopy
) -> None:
    """OneDrive verify succeeds against the copy with the read-only user."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER is not set")
    snapshot = _latest_snapshot(s3, bucket_copy.bucket, "onedrive")

    cli.ok(
        "onedrive",
        "verify",
        "-o",
        settings.onedrive_owner,
        "-s",
        snapshot,
        extra_env=bucket_copy.cli_env(),
    )


def test_04_sharepoint_verify_reads_the_copy(
    cli: Cli, settings: Settings, s3: Any, bucket_copy: ReadOnlyCopy
) -> None:
    """SharePoint verify succeeds against the copy with the read-only user."""
    if not settings.sharepoint_site:
        pytest.skip("E2E_SHAREPOINT_SITE is not set")
    snapshot = _latest_snapshot(s3, bucket_copy.bucket, "sharepoint")

    cli.ok(
        "sharepoint",
        "verify",
        "--site",
        settings.sharepoint_site,
        "-s",
        snapshot,
        extra_env=bucket_copy.cli_env(),
    )


def test_05_the_override_refuses_another_tenant(cli: Cli, bucket_copy: ReadOnlyCopy) -> None:
    """`-t` cannot reach another tenant while the run's override is set, so no bucket is read."""
    result = cli.run("outlook", "list", "-t", OTHER_TENANT, extra_env=bucket_copy.cli_env())

    assert result.code == EXIT_CONFIG, result.describe()


def test_06_a_missing_override_bucket_is_never_created(
    cli: Cli, s3: Any, bucket_copy: ReadOnlyCopy, run_marker: str
) -> None:
    """A mistyped override fails instead of creating a bucket, even with write credentials."""
    missing = f"{run_marker}-missing"

    result = cli.run("outlook", "list", extra_env={"ATLAS_S3_BUCKET": missing})

    assert result.code == EXIT_CONFIG, result.describe()
    assert not storage.bucket_exists(s3, missing)


def test_07_nothing_was_written(settings: Settings, s3: Any, bucket_copy: ReadOnlyCopy) -> None:
    """No object, version, marker, upload or bucket appeared, and the primary is untouched."""
    assert storage.version_listing(s3, bucket_copy.bucket) == STATE["listing"]
    assert storage.version_listing(s3, settings.bucket) == STATE["primary"]
    assert storage.bucket_names(s3) == STATE["buckets"]
