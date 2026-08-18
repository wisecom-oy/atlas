"""Object Lock: retention is real, and deleting a locked object fails.

Runs after `test_90_purge.py` on purpose. Atlas never sends `BypassGovernanceRetention`, so an
object it locks stays undeletable until expiry -- locking anything earlier would make the purge
assertion unsatisfiable. What this suite locks is left behind deliberately: the workflow destroys
the MinIO volumes afterwards, so the write protection never has to hold past the job.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from botocore.exceptions import ClientError

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


def test_01_backup_applies_retention(cli: Cli, settings: Settings, s3: Any) -> None:
    """A backup with `--retention-days 1 --require-immutability` stamps retention on what it writes.

    `--require-immutability` is the point: it makes the run fail rather than silently downgrade to
    mutable writes, which is the failure mode an operator would never notice. A clean exit is the
    whole signal here -- the flag's contract is to fail otherwise -- and whether retention actually
    landed is read from S3 in the next test, not from the run's own summary.
    """
    cli.ok(
        "outlook",
        "backup",
        "-m",
        settings.mailbox,
        "--retention-days",
        "1",
        "--lock-mode",
        "governance",
        "--require-immutability",
    )

    owner_keys = [k for k in storage.list_keys(s3, settings.bucket) if k.startswith("data/")]
    assert owner_keys, "the locked backup stored no message blob"
    STATE["locked_key"] = owner_keys[0]


def test_02_retention_is_present_on_the_object(settings: Settings, s3: Any) -> None:
    """S3 itself reports the retention, not just Atlas's summary."""
    retention = storage.retention(s3, settings.bucket, STATE["locked_key"])
    assert retention, f"no Object Lock retention on {STATE['locked_key']}"

    assert retention["Mode"].lower() == "governance", retention
    retain_until = retention["RetainUntilDate"]
    if retain_until.tzinfo is None:
        retain_until = retain_until.replace(tzinfo=timezone.utc)
    assert retain_until > datetime.now(timezone.utc), f"retention already expired: {retain_until}"


def test_03_storage_check_still_reports_lock_capable(cli: Cli, settings: Settings) -> None:
    """The bucket remains classified as lock-capable for the mode that was just used."""
    result = cli.ok("storage-check", "--lock-mode", "governance", "--retention-days", "1")
    assert "lock-capable" in result.out, result.describe()


def test_04_deleting_the_locked_version_fails(settings: Settings, s3: Any) -> None:
    """The backend refuses to delete the locked version -- no bypass exists.

    Asked at the S3 API directly: if this call ever succeeds, the retention Atlas stamped is not
    being enforced, and everything reported above was decoration. Note the version id: a plain
    delete on a versioned bucket only adds a delete marker, which Object Lock permits by design --
    retention protects the *version*.
    """
    key = STATE["locked_key"]
    versions = s3.list_object_versions(Bucket=settings.bucket, Prefix=key).get("Versions", [])
    version_id = next(v["VersionId"] for v in versions if v["Key"] == key)

    with pytest.raises(ClientError) as denied:
        s3.delete_object(Bucket=settings.bucket, Key=key, VersionId=version_id)
    assert denied.value.response["Error"]["Code"] == "AccessDenied", denied.value.response

    assert key in storage.list_keys(s3, settings.bucket), "locked version deleted despite retention"
