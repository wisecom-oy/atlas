"""Object Lock: retention lands on what a backup writes, and only the retention protects it.

Runs after `test_90_purge.py` on purpose. Atlas never sends `BypassGovernanceRetention`, so an
object it locks stays undeletable until expiry -- locking anything earlier would make the purge
assertion unsatisfiable. What this suite locks is left behind deliberately: the workflow destroys
the MinIO volumes afterwards, so the write protection never has to hold past the job.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


def test_01_backup_applies_retention(cli: Cli, settings: Settings, s3: Any) -> None:
    """A backup with `--retention-days 1` stamps retention on what it writes.

    Requesting retention is fail-closed: the run aborts rather than silently downgrading to
    mutable writes, which is the failure mode an operator would never notice. A clean exit is the
    whole signal here, and whether retention actually landed is read from S3 in the next test,
    not from the run's own summary.
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


def test_04_deleting_an_unlocked_object_works(settings: Settings, s3: Any) -> None:
    """Control: an object without retention deletes fine, so the stamp above is the difference.

    Deleting the *locked* object is deliberately not attempted: it errors by design, and the
    teardown that owns those bytes is the workflow destroying the MinIO volumes -- retention cannot
    stop that, and no cleanup path needs to.
    """
    # Written here rather than borrowed from an earlier suite: by this point every object in the
    # bucket was either purged or written by the locked backup above.
    key = "_meta/e2e-delete-control"
    s3.put_object(Bucket=settings.bucket, Key=key, Body=b"control")

    s3.delete_object(Bucket=settings.bucket, Key=key)
    assert key not in storage.list_keys(s3, settings.bucket), "an unlocked object refused to delete"
