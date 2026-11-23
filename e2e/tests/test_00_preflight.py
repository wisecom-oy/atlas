"""Preflight: fail in seconds with a named cause instead of cascading red through every suite."""

from __future__ import annotations

import re
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
    assert re.search(r"Status:\s+ready", result.out), result.describe()


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


def test_contacts_permission(graph: Graph, settings: Settings) -> None:
    """Contacts.ReadWrite: required by the contacts suite, which skips itself without it."""
    _require(
        graph,
        f"/users/{settings.mailbox}/contactFolders",
        "Contacts.ReadWrite",
        **{"$top": 1, "$select": "id"},
    )


def test_calendars_permission(graph: Graph, settings: Settings) -> None:
    """Calendars.ReadWrite: required by the calendar suite, which skips itself without it."""
    _require(
        graph,
        f"/users/{settings.mailbox}/calendars",
        "Calendars.ReadWrite",
        **{"$top": 1, "$select": "id"},
    )


def test_teams_permissions(graph: Graph, settings: Settings) -> None:
    """The Teams read permissions, probed on the configured team.

    Three calls, each naming the grant it needs. `ChannelMessage.Read.All` is a protected API, so
    it can be consented and still refused until Microsoft approves the tenant.
    """
    if not settings.team_id:
        pytest.skip("E2E_TEAM_ID not set")
    team = f"/teams/{settings.team_id}"
    _require(graph, team, "Team.ReadBasic.All", **{"$select": "id"})
    channels = _require(graph, f"{team}/channels", "Channel.ReadBasic.All", **{"$select": "id"})
    channel_id = channels["value"][0]["id"]
    _require(
        graph,
        f"{team}/channels/{channel_id}/messages",
        "ChannelMessage.Read.All",
        **{"$top": 1},
    )


def test_tenant_bucket_is_local_only(settings: Settings, s3: Any) -> None:
    """The endpoint under test is the runner's MinIO, never a production endpoint.

    The bucket name carries the real tenant id, so pointing the suite at a shared endpoint would
    write test data into a real tenant's bucket. Localhost-only is the guard.
    """
    assert any(host in settings.s3_endpoint for host in ("127.0.0.1", "localhost", "minio")), (
        f"E2E_S3_ENDPOINT must be a runner-local MinIO, got {settings.s3_endpoint}"
    )


"""Statuses that mean the app lacks a grant; any other failure is Graph itself."""
PERMISSION_DENIED_STATUSES = {401, 403}


def _require(graph: Graph, path: str, permission: str, **params: Any) -> dict[str, Any]:
    """Asserts a Graph endpoint is reachable, naming the permission only when Graph denied it."""
    try:
        return graph.get(path, **params)
    except GraphError as err:
        if err.status in PERMISSION_DENIED_STATUSES:
            pytest.fail(f"{permission} appears to be missing or unconsented: {err}")
        pytest.fail(f"Graph failed while probing {permission}, not a permission denial: {err}")
