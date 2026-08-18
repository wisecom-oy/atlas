"""Preflight: fail in seconds with a named cause instead of cascading red through every suite."""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph, GraphError


def test_cli_bundle_runs(cli: Cli) -> None:
    """The built bundle is executable; otherwise `pnpm run build` was skipped."""
    result = cli.ok("--version")
    assert result.stdout.strip(), result.describe()


def test_config_validate_probes_graph_and_s3(cli: Cli) -> None:
    """`config validate` performs a live Graph token request and an S3 ListBuckets."""
    cli.ok("config", "validate")


def test_storage_check_reports_lock_capable(cli: Cli, settings: Settings, s3: Any) -> None:
    """The backend must accept a lock-capable bucket, or the immutability suite tests nothing.

    MinIO only supports Object Lock on a versioning-capable backend, which is why the compose file
    gives each container four drives. A regressed image shows up here, not ten tests later.

    The bucket is created here with `ObjectLockEnabledForBucket`, exactly as the product does on
    first backup (`s3-bucket-manager.ts`). It cannot be left to `storage-check`, which is read-only
    and reports `not-ready` for a bucket that does not exist yet -- and read-only commands provision
    nothing since issue #93.
    """
    if not storage.bucket_exists(s3, settings.bucket):
        s3.create_bucket(Bucket=settings.bucket, ObjectLockEnabledForBucket=True)

    result = cli.ok("storage-check")
    assert "lock-capable" in result.out, result.describe()
    assert "Status:          ready" in result.out, result.describe()


def test_storage_helpers_read_snapshot_ids(settings: Settings, s3: Any, run_marker: str) -> None:
    """Guards the key parsing every later assertion depends on.

    Snapshot ids are read out of `manifests/<owner>/<snapshot>.json` key names rather than from CLI
    tables. If that parsing breaks, the lifecycle suites would compare empty lists and pass, so it
    is checked here against a throwaway object.
    """
    key = f"manifests/{run_marker}/{run_marker}-snap.json"
    s3.put_object(Bucket=settings.bucket, Key=key, Body=b"probe")
    try:
        assert storage.snapshot_ids(s3, settings.bucket, run_marker) == [f"{run_marker}-snap"]
        assert key in storage.list_keys(s3, settings.bucket, "manifests/")
    finally:
        s3.delete_object(Bucket=settings.bucket, Key=key)



def test_graph_token_is_issued(graph: Graph) -> None:
    """App-only credentials are accepted by the tenant."""
    assert graph.token()


def test_mail_readwrite_permission(graph: Graph, settings: Settings) -> None:
    """Mail.ReadWrite: required to seed and to restore mail."""
    _require(graph, f"/users/{settings.mailbox}/mailFolders", "Mail.ReadWrite", **{"$top": 1})


def test_mail_read_permission(graph: Graph, settings: Settings) -> None:
    """Mail.Read: what backup, list, save and verify actually read with."""
    _require(
        graph,
        f"/users/{settings.mailbox}/mailFolders/inbox/messages",
        "Mail.Read",
        **{"$top": 1, "$select": "id"},
    )


def test_mailbox_settings_read_permission(graph: Graph, settings: Settings) -> None:
    """MailboxSettings.Read: folder enumeration and shared-mailbox detection (`userPurpose`).

    Probed separately because listing `mailFolders` succeeds without it, so a missing grant would
    otherwise only surface mid-backup as a bare 403 (as it did on run 32134203049).
    """
    _require(
        graph,
        f"/users/{settings.mailbox}/mailboxSettings",
        "MailboxSettings.Read",
        **{"$select": "userPurpose"},
    )


def test_user_read_all_permission(graph: Graph) -> None:
    """User.Read.All: mailbox and owner discovery, and email-to-object-id resolution."""
    _require(graph, "/users", "User.Read.All", **{"$top": 1, "$select": "id"})


def test_files_readwrite_permission(graph: Graph, settings: Settings) -> None:
    """Files.ReadWrite.All: required by the OneDrive suite."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")
    _require(graph, f"/users/{settings.onedrive_owner}/drives", "Files.ReadWrite.All")


def test_sites_read_permission(graph: Graph, settings: Settings) -> None:
    """Sites.Read.All: required by the SharePoint suite."""
    if not settings.sharepoint_site:
        pytest.skip("E2E_SHAREPOINT_SITE not set")
    _require(graph, "/sites", "Sites.Read.All", search="*")


def test_tenant_bucket_is_local_only(settings: Settings, s3: Any) -> None:
    """The endpoint under test is the runner's MinIO, never a production endpoint.

    The bucket name carries the real tenant id, so pointing the suite at a shared endpoint would
    write test data into a real tenant's bucket. Localhost-only is the guard.
    """
    assert any(host in settings.s3_endpoint for host in ("127.0.0.1", "localhost", "minio")), (
        f"E2E_S3_ENDPOINT must be a runner-local MinIO, got {settings.s3_endpoint}"
    )


def _require(graph: Graph, path: str, permission: str, **params: Any) -> None:
    """Asserts a Graph endpoint is reachable, naming the permission that is missing when it is not."""
    try:
        graph.get(path, **params)
    except GraphError as err:
        pytest.fail(f"{permission} appears to be missing or unconsented: {err}")
