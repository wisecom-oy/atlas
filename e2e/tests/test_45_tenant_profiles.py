"""Tenant profiles: the Graph identity comes from a stored profile, not from the environment.

Every other suite passes `ATLAS_TENANT_ID`, `ATLAS_CLIENT_ID` and `ATLAS_CLIENT_SECRET`, which
replace whatever a profile holds, so none of them would notice a broken profile store. This one
runs a CLI with those three unset and a home directory of its own, so the profiles it saves are
never seen by the other suites.

The store key goes to the OS keyring when one is present and to a file in the home directory
otherwise. A CI runner has no keyring, which is the file path.

Cross-tenant restore (`--target-profile`) needs a second tenant and is tracked in #782.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import config, storage
from atlas_e2e.atlas import Cli, Result
from atlas_e2e.config import Settings

PROFILE = "e2e-primary"
OTHER_PROFILE = "e2e-missing-bucket"


@pytest.fixture(scope="module")
def profile_cli(settings: Settings, tmp_path_factory: pytest.TempPathFactory) -> Cli:
    """A CLI with no Graph identity in its environment and an empty home."""
    home: Path = tmp_path_factory.mktemp("atlas-profile-home")
    transcript = config.REPO_ROOT / "e2e" / "logs" / "cli.log"
    return Cli(settings, home, transcript=transcript, graph_env=False)


def test_01_no_profile_means_no_identity(profile_cli: Cli) -> None:
    """Without a profile or the variables, a Graph command refuses to start."""
    result = profile_cli.run("tenants", "validate")
    assert result.code != 0, result.describe()


def test_02_add_saves_a_profile_and_checks_it(profile_cli: Cli, settings: Settings) -> None:
    """`tenants add` reads the secret from stdin, stores the profile and requests a Graph token."""
    _add(profile_cli, settings, PROFILE)

    listed = profile_cli.ok("tenants", "list")
    assert PROFILE in listed.out, listed.describe()
    assert settings.client_secret not in listed.out, "tenants list printed the client secret"


def test_03_validate_checks_graph_and_the_bucket(profile_cli: Cli) -> None:
    """`tenants validate <name>` gets a token and sends the profile's bucket `HeadBucket`."""
    profile_cli.ok("tenants", "validate", PROFILE)


def test_04_a_command_runs_on_the_selected_profile(
    profile_cli: Cli, settings: Settings, s3: Any
) -> None:
    """`--profile` supplies the tenant, so the run opens the bucket the workload suites wrote to.

    `outlook status` is the proof of both halves: it reads the newest manifest from storage and
    replays its sync checkpoints against Graph, with nothing but the profile to authenticate with.
    """
    assert storage.owner_segments(s3, settings.bucket, "outlook"), "no Outlook backup to read"

    profile_cli.ok("--profile", PROFILE, "outlook", "list", "-m", settings.mailbox)
    profile_cli.ok("--profile", PROFILE, "outlook", "status", "-m", settings.mailbox)


def test_05_use_makes_the_profile_the_default(profile_cli: Cli, settings: Settings) -> None:
    """After `tenants use`, the same command needs no `--profile`."""
    profile_cli.ok("tenants", "use", PROFILE)
    profile_cli.ok("outlook", "list", "-m", settings.mailbox)


def test_06_a_profile_bucket_that_does_not_exist_fails_validation(
    profile_cli: Cli, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A profile's `--bucket` is never created: validation fails and the endpoint is unchanged.

    The exit code of `tenants add` is not asserted. It reports the Graph check, and whether it also
    reports the bucket is not what this test is about; the profile is kept either way.
    """
    missing = f"{run_marker}-no-such-bucket"
    before = storage.bucket_names(s3)

    _add(profile_cli, settings, OTHER_PROFILE, "--bucket", missing, expect_ok=False)
    assert OTHER_PROFILE in profile_cli.ok("tenants", "list").out

    result = profile_cli.run("tenants", "validate", OTHER_PROFILE)
    assert result.code != 0, result.describe()
    assert storage.bucket_names(s3) == before, "validating a profile created a bucket"


def test_07_remove_deletes_the_profiles(profile_cli: Cli, settings: Settings) -> None:
    """Removing the active profile needs `-y`, and leaves no identity to run with."""
    profile_cli.ok("tenants", "remove", OTHER_PROFILE)
    assert profile_cli.run("tenants", "remove", PROFILE).code != 0, (
        "the active profile was removed without -y"
    )
    profile_cli.ok("tenants", "remove", PROFILE, "-y")

    assert PROFILE not in profile_cli.ok("tenants", "list").out
    assert profile_cli.run("outlook", "list", "-m", settings.mailbox).code != 0


def _add(cli: Cli, settings: Settings, name: str, *flags: str, expect_ok: bool = True) -> Result:
    """Saves a profile for the suite's tenant, passing the secret on stdin."""
    args = (
        "tenants",
        "add",
        name,
        "--tenant-id",
        settings.tenant_id,
        "--client-id",
        settings.client_id,
        "--client-secret",
        "-",
        *flags,
    )
    run = cli.ok if expect_ok else cli.run
    return run(*args, stdin=settings.client_secret)
