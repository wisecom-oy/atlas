"""Exit codes, one end-to-end proof per code a scheduled job can produce cheaply.

Runs on the snapshots the workload suites (`test_10` to `test_60`) left and before `test_80_keys`,
which needs the bucket opened with the session passphrase. Every case is refused before it changes
anything, so an autouse fixture asserts the bucket's snapshot set after each test.

Covered elsewhere and not repeated: exit 7 for a selector that matches nothing (`test_12`), exit 5
after a rotation (`test_80`), exit 7 for an unknown snapshot or tenant (`test_35`). Exit 3 needs a
failing Graph and exit 12 a held lease, so neither is produced here.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import config, exits, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

# A tenant id in valid GUID form that is not the suite's tenant.
OTHER_TENANT = str(uuid.UUID(int=0xE2E))
PROFILE = "e2e-exit-codes"

STATE: dict[str, Any] = {}


@pytest.fixture(autouse=True)
def _snapshot_set_is_unchanged(settings: Settings, s3: Any) -> Iterator[None]:
    """Every case here is refused, so no manifest may appear or disappear."""
    before = exits.manifest_keys(s3, settings.bucket)
    yield
    assert exits.manifest_keys(s3, settings.bucket) == before, "a refused command changed snapshots"


@pytest.fixture(scope="module")
def profile_cli(settings: Settings, tmp_path_factory: pytest.TempPathFactory) -> Cli:
    """A CLI with no Graph identity in its environment and a home of its own."""
    home: Path = tmp_path_factory.mktemp("atlas-exit-codes-home")
    return Cli(
        settings, home, transcript=config.REPO_ROOT / "e2e" / "logs" / "cli.log", graph_env=False
    )


def _outlook_snapshots(settings: Settings, s3: Any) -> list[str]:
    """Outlook snapshot ids, oldest first by manifest write time."""
    owners = storage.owner_segments(s3, settings.bucket, "outlook")
    assert len(owners) == 1, f"expected one backed-up mailbox, found {len(owners)}"
    keys = exits.keys_oldest_first(s3, settings.bucket, f"manifests/{owners[0]}/")
    return [exits.snapshot_id_of(key) for key in keys]


def test_01_wrong_passphrase_exits_5_and_writes_nothing(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """Each workload's `verify` under a wrong passphrase exits 5 and leaves every version alone.

    The data key fails to unwrap (`WrongPassphraseError`, envelope-key-service.adapter.ts), which
    happens before any read of backup data and before any lease, so nothing is written.
    """
    commands = exits.verify_commands(settings, s3)
    assert "outlook" in commands, "no Outlook snapshot to read"
    before = storage.version_listing(s3, settings.bucket)
    env = {"ATLAS_ENCRYPTION_PASSPHRASE": exits.wrong(settings.passphrase)}

    for argv in commands.values():
        result = cli.run(*argv, extra_env=env)
        assert result.code == exits.EXIT_WRONG_PASSPHRASE, result.describe()

    assert storage.version_listing(s3, settings.bucket) == before, "a refused read wrote"


def test_02_a_missing_required_setting_exits_6(cli: Cli) -> None:
    """An empty `ATLAS_*` value counts as unset, and a missing field fails config loading.

    `merge_and_validate` throws and `compose_container` wraps it as `ConfigError` (container.ts).
    """
    for variable in ("ATLAS_ENCRYPTION_PASSPHRASE", "ATLAS_CLIENT_SECRET"):
        result = cli.run("outlook", "list", extra_env={variable: ""})
        assert result.code == exits.EXIT_CONFIG_INVALID, result.describe()


def test_03_a_bad_bucket_override_exits_6_and_creates_nothing(
    cli: Cli, s3: Any, run_marker: str
) -> None:
    """`ATLAS_S3_BUCKET` with an invalid name, or naming no bucket, is a config error.

    A configured bucket is never created, so the endpoint's bucket list must not change.
    """
    before = storage.bucket_names(s3)
    for bucket in ("Not_A_Bucket", f"{run_marker}-absent"):
        result = cli.run("outlook", "list", extra_env={"ATLAS_S3_BUCKET": bucket})
        assert result.code == exits.EXIT_CONFIG_INVALID, result.describe()
    assert storage.bucket_names(s3) == before, "a configured bucket was created"


def test_04_invalid_teams_arguments_exit_6(cli: Cli) -> None:
    """A tenant domain, a team id that is not a GUID, and an out-of-range concurrency.

    All three are checked before any Graph call or storage read, so no team needs configuring.
    """
    team = str(uuid.UUID(int=0xE2E))
    for argv in (
        ("teams", "backup", "--team", team, "-t", "example.onmicrosoft.com"),
        ("teams", "backup", "--team", team, "--concurrency", "99"),
        ("teams", "verify", "--team", "not-a-guid", "-s", "unused"),
    ):
        result = cli.run(*argv)
        assert result.code == exits.EXIT_CONFIG_INVALID, result.describe()


def test_05_a_partial_graph_override_exits_6(profile_cli: Cli, settings: Settings) -> None:
    """`ATLAS_TENANT_ID` alone, against a profile with another tenant, would mix two identities.

    `assert_override_keeps_one_identity` refuses it while loading the configuration.
    """
    profile_cli.ok(
        "tenants",
        "add",
        PROFILE,
        "--tenant-id",
        settings.tenant_id,
        "--client-id",
        settings.client_id,
        "--client-secret",
        "-",
        stdin=settings.client_secret,
    )
    result = profile_cli.run(
        "--profile", PROFILE, "outlook", "list", extra_env={"ATLAS_TENANT_ID": OTHER_TENANT}
    )
    assert result.code == exits.EXIT_CONFIG_INVALID, result.describe()


def test_06_a_wrong_storage_secret_exits_4(cli: Cli, settings: Settings, s3: Any) -> None:
    """S3 answers a bad signature with 403, which the CLI classifies as an authorization failure."""
    before = storage.version_listing(s3, settings.bucket)
    result = cli.run(
        "outlook",
        "list",
        "-m",
        settings.mailbox,
        extra_env={"ATLAS_S3_SECRET_KEY": exits.wrong(settings.s3_secret_key)},
    )
    assert result.code == exits.EXIT_AUTH_DENIED, result.describe()
    assert storage.version_listing(s3, settings.bucket) == before


def test_07_a_wrong_client_secret_fails_a_graph_command(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """`outlook mailboxes` reads Graph only, so a wrong client secret must fail it."""
    before = storage.version_listing(s3, settings.bucket)
    result = cli.run(
        "outlook",
        "mailboxes",
        extra_env={"ATLAS_CLIENT_SECRET": exits.wrong(settings.client_secret)},
    )
    STATE["wrong_secret"] = result
    assert result.code != 0, result.describe()
    assert storage.version_listing(s3, settings.bucket) == before


def test_07b_a_wrong_client_secret_exits_4() -> None:
    """Microsoft Entra ID refuses the token request, which the CLI reports as ATLAS_AUTH_DENIED."""
    assert "wrong_secret" in STATE, "test_07 did not run"
    assert STATE["wrong_secret"].code == exits.EXIT_AUTH_DENIED, STATE["wrong_secret"].describe()


def test_08_storage_only_commands_ignore_the_client_secret(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """Listing a snapshot needs no Graph, and `-m` falls back to the identity registry.

    The registry fallback is `CachingIdentityResolver.resolve_user`: a Graph failure for an address
    the registry holds returns the cached identity instead of failing the read.
    """
    snapshot = _outlook_snapshots(settings, s3)[0]
    before = storage.version_listing(s3, settings.bucket)
    env = {"ATLAS_CLIENT_SECRET": exits.wrong(settings.client_secret)}

    cli.ok("outlook", "list", "-s", snapshot, extra_env=env)
    cli.ok("outlook", "list", "-m", settings.mailbox, extra_env=env)
    assert storage.version_listing(s3, settings.bucket) == before


def test_09_an_unknown_owner_exits_7_not_4(
    cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """An address Graph does not know and the registry never held is `ATLAS_NOT_FOUND`.

    Graph answers 404 for the UPN, the `mail` filter finds no one, and only a 404 becomes
    `NotFoundError`. Backup resolves the owner before it takes a lease, so nothing is written.
    """
    unknown = f"{run_marker}@example.com"
    commands: list[tuple[str, ...]] = [("outlook", "backup", "-m", unknown)]
    if settings.onedrive_owner:
        commands.append(("onedrive", "backup", "-o", unknown))
    before = storage.version_listing(s3, settings.bucket)

    for argv in commands:
        result = cli.run(*argv)
        assert result.code == exits.EXIT_NOT_FOUND, result.describe()
    assert storage.version_listing(s3, settings.bucket) == before


def test_10_deleting_an_older_snapshot_exits_11(cli: Cli, settings: Settings, s3: Any) -> None:
    """A snapshot newer ones build on is refused, for Outlook and each configured drive.

    The refusal comes after the owner lease is taken, so the lease's own versions change; every
    other key must not.
    """
    outlook = _outlook_snapshots(settings, s3)
    assert len(outlook) >= 2, f"need two Outlook snapshots, found {len(outlook)}"
    commands: list[tuple[str, ...]] = [("outlook", "delete", "-s", outlook[0], "-y")]
    for workload, flag, value in (
        ("onedrive", "-o", settings.onedrive_owner),
        ("sharepoint", "--site", settings.sharepoint_site),
    ):
        segments = storage.owner_segments(s3, settings.bucket, workload)
        drive = (
            sorted(storage.snapshot_ids(s3, settings.bucket, segments[0], workload))
            if segments
            else []
        )
        # Drive ids embed their creation time in milliseconds, so the sorted first is the oldest.
        if value and len(drive) >= 2:
            commands.append((workload, "delete", flag, value, "-s", drive[0], "-y"))
    before = exits.durable_keys(s3, settings.bucket)

    for argv in commands:
        result = cli.run(*argv)
        assert result.code == exits.EXIT_SNAPSHOT_NOT_NEWEST, result.describe()
    assert exits.durable_keys(s3, settings.bucket) == before, "a refused delete removed objects"


def test_11_usage_errors_exit_1(cli: Cli, settings: Settings, s3: Any) -> None:
    """Flag combinations the CLI refuses before doing any work.

    `--lock-mode` without `--retention-days` is a plain `Error` in `command-object-lock.ts`, so it
    exits 1 rather than 6. An unknown mode is rejected by commander's `choices`, also 1.
    """
    snapshot = _outlook_snapshots(settings, s3)[0]
    mailbox = settings.mailbox
    before = exits.durable_keys(s3, settings.bucket)

    for argv in (
        ("outlook", "restore", "-s", snapshot, "-m", mailbox),
        ("outlook", "restore", "-s", snapshot, "--message", ""),
        ("outlook", "restore", "-m", mailbox, "--message", "1"),
        ("outlook", "restore"),
        ("outlook", "delete"),
        ("outlook", "backup", "-m", mailbox, "--lock-mode", "governance"),
        ("outlook", "backup", "-m", mailbox, "--lock-mode", "bogus"),
    ):
        result = cli.run(*argv, stdin="")
        assert result.code == exits.EXIT_FAILURE, result.describe()
    assert exits.durable_keys(s3, settings.bucket) == before
