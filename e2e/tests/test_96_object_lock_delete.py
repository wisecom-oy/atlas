"""Deleting backups under Object Lock through Atlas: retained, reported, and still in S3.

Runs after `test_95_immutability`, whose locked Outlook backup is by then the only snapshot in the
bucket. Atlas deletes by version id and never sends `BypassGovernanceRetention`, so S3 refuses each
locked version. The deletion counts the refusal as retained rather than failed and exits 1
(`print_delete_result` in `deletion-presenter.tsx`). `ObjectLockRetainedError` and its exit 8 never
reach the CLI from a delete: the deletion services count it per object instead of throwing it.
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from atlas_e2e import exits, storage
from atlas_e2e.atlas import Cli, Result
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}

# Printed by `print_delete_result`. The retained and failed split exists only in the summary line,
# so this one string is the assertion that S3 cited the lock and refused for no other reason.
NO_OTHER_FAILURES = "Failed for other reasons: 0 object(s), 0 manifest(s)"


def _is_retained(s3: Any, bucket: str, key: str, version_id: str) -> bool:
    """Whether S3 reports Object Lock retention on one exact version."""
    try:
        response = s3.get_object_retention(Bucket=bucket, Key=key, VersionId=version_id)
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchObjectLockConfiguration", "ObjectLockConfigurationNotFoundError"}:
            return False
        raise
    return bool(response.get("Retention"))


def _locked_versions(s3: Any, bucket: str, owner: str) -> list[tuple[str, str]]:
    """The owner's manifest and data versions that carry retention, as (key, version id)."""
    return [
        (key, version)
        for prefix in (f"manifests/{owner}/", f"data/{owner}/")
        for key, version in exits.versions_under(s3, bucket, prefix)
        if _is_retained(s3, bucket, key, version)
    ]


def _assert_still_stored(s3: Any, bucket: str, locked: list[tuple[str, str]]) -> None:
    """Every locked version is still in the bucket, under its original version id."""
    for key, version in locked:
        assert version in storage.object_version_ids(s3, bucket, key), (
            f"{key} lost a locked version"
        )


def _assert_retained_not_failed(result: Result) -> None:
    """Exit 1, and every survivor was refused for retention, not for some other reason."""
    assert result.code == exits.EXIT_FAILURE, result.describe()
    assert NO_OTHER_FAILURES in result.out, result.describe()


def test_01_the_locked_backup_is_found(settings: Settings, s3: Any) -> None:
    """The `test_95` backup is the only Outlook snapshot, with its manifest and data locked."""
    owners = storage.owner_segments(s3, settings.bucket, "outlook")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    snapshots = storage.snapshot_ids(s3, settings.bucket, owners[0])
    assert len(snapshots) == 1, f"expected only the locked snapshot, found {len(snapshots)}"

    locked = _locked_versions(s3, settings.bucket, owners[0])
    assert any(key.startswith("manifests/") for key, _ in locked), "the manifest is not locked"
    assert any(key.startswith("data/") for key, _ in locked), "no data object is locked"
    STATE.update(owner=owners[0], snapshot=snapshots[0], locked=locked)


def test_02_a_snapshot_delete_reports_the_manifest_retained(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """`outlook delete -s` on a locked manifest exits 1 and leaves the snapshot in place.

    `DeletionService.delete_snapshot` returns as soon as the manifest survives, so the pointers
    and the cursor are not touched either.
    """
    before = exits.durable_keys(s3, settings.bucket)

    result = cli.run("outlook", "delete", "-s", STATE["snapshot"], "-y")

    _assert_retained_not_failed(result)
    _assert_still_stored(s3, settings.bucket, STATE["locked"])
    assert exits.durable_keys(s3, settings.bucket) == before, "a retained delete removed objects"


def test_03_a_mailbox_delete_removes_only_what_is_unlocked(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """`outlook delete -m` keeps every locked version and erases the unlocked ones around it.

    The snapshot pointer is written without retention, so its removal proves the sweep went on
    past the refused versions instead of stopping at the first one.
    """
    pointer = f"_meta/outlook-manifests/snapshots/{STATE['snapshot']}.json"
    assert storage.object_version_ids(s3, settings.bucket, pointer), "no snapshot pointer to erase"

    result = cli.run("outlook", "delete", "-m", settings.mailbox, "-y")

    _assert_retained_not_failed(result)
    _assert_still_stored(s3, settings.bucket, STATE["locked"])
    assert storage.object_version_ids(s3, settings.bucket, pointer) == [], (
        "an unlocked object survived the mailbox delete"
    )
