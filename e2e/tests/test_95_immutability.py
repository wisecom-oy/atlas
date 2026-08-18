"""Object Lock: retention is real, and a delete that hits it is reported as retained, not failed.

Runs after `test_90_purge.py` on purpose. Atlas never sends `BypassGovernanceRetention`, so an object
it locks stays undeletable until expiry **in governance mode too** -- locking anything earlier would
make the purge assertion unsatisfiable. Everything this suite locks is left behind deliberately, and
the workflow destroys the MinIO volumes afterwards, so nothing survives the job.

Lock mode comes from `E2E_LOCK_MODE`: `governance` on the weekly leg, `compliance` on the monthly one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


def test_01_backup_applies_retention(cli: Cli, settings: Settings, s3: Any, run_marker: str) -> None:
    """A backup with `--retention-days 1 --require-immutability` stamps retention on what it writes.

    `--require-immutability` is the point: it makes the run fail rather than silently downgrade to
    mutable writes, which is the failure mode an operator would never notice.
    """
    result = cli.ok(
        "outlook",
        "backup",
        "-m",
        settings.mailbox,
        "-f",
        run_marker,
        "--retention-days",
        "1",
        "--lock-mode",
        settings.lock_mode,
        "--require-immutability",
    )
    assert "immutab" in result.out.lower(), result.describe()

    owner_keys = [k for k in storage.list_keys(s3, settings.bucket) if k.startswith("data/")]
    assert owner_keys, "the locked backup stored no message blob"
    STATE["locked_key"] = owner_keys[0]


def test_02_retention_is_present_on_the_object(settings: Settings, s3: Any) -> None:
    """S3 itself reports the retention, not just Atlas's summary."""
    retention = storage.retention(s3, settings.bucket, STATE["locked_key"])
    assert retention, f"no Object Lock retention on {STATE['locked_key']}"

    assert retention["Mode"].lower() == settings.lock_mode.lower(), retention
    retain_until = retention["RetainUntilDate"]
    if retain_until.tzinfo is None:
        retain_until = retain_until.replace(tzinfo=timezone.utc)
    assert retain_until > datetime.now(timezone.utc), f"retention already expired: {retain_until}"


def test_03_storage_check_still_reports_lock_capable(cli: Cli, settings: Settings) -> None:
    """The bucket remains classified as lock-capable for the mode that was just used."""
    result = cli.ok("storage-check", "--lock-mode", settings.lock_mode, "--retention-days", "1")
    assert "lock-capable" in result.out, result.describe()


def test_04_delete_reports_retained_not_failed(cli: Cli, settings: Settings, s3: Any) -> None:
    """A delete blocked by Object Lock is reported as retained, and the bytes are still there.

    The distinction is the whole feature: `retained` means the backend named Object Lock and the
    object becomes deletable when retention expires. `failed` means something that will not resolve
    on its own, like an IAM denial. Conflating them would send an operator hunting a permissions bug
    that does not exist -- or worse, treat an immutability guarantee as a transient error.
    """
    result = cli.run("outlook", "delete", "-m", settings.mailbox, "-y")

    assert result.code != 0, "a delete blocked by retention must not report success"
    assert "Retained and not deleted" in result.out, result.describe()

    survivors = storage.list_keys(s3, settings.bucket)
    assert STATE["locked_key"] in survivors, "a retained object was deleted anyway"


@pytest.mark.compliance
def test_05_compliance_objects_are_left_for_the_next_run(settings: Settings, s3: Any) -> None:
    """On the compliance leg, the locked objects are expected survivors -- attributable, not stray.

    Atlas has no governance bypass, so this holds for either mode: every object still in the bucket
    at this point must be one this suite locked with `--retention-days 1`. The next run starts on a
    fresh MinIO volume regardless.
    """
    if settings.lock_mode != "compliance":
        pytest.skip("governance leg: retention semantics are asserted by the tests above")

    survivors = storage.list_keys(s3, settings.bucket)
    unattributable = [k for k in survivors if not k.startswith(("data/", "attachments/", "manifests/", "_meta/"))]
    assert not unattributable, f"unexplained survivors in the bucket: {unattributable[:5]}"
