"""Passphrase rotation: re-wrap the data key, retire the old passphrase, purge, rotate back.

Runs after every workload suite, so there are snapshots to read under each passphrase, and before
the deletion suites, which need the bucket to open with the passphrase the session started with.
The last test and the module fixture both put that passphrase back: a rotation left half done
would fail every command that follows with exit 5.

The passphrase reaches the CLI on stdin. `keys` refuses it as a flag value, which keeps it out of
the process table and out of the transcript this suite uploads.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

DEK_KEY = "_meta/dek.enc"
EXIT_WRONG_PASSPHRASE = 5

STATE: dict[str, Any] = {"rotated": False}


def _rotated_passphrase(settings: Settings) -> str:
    """The temporary passphrase. Derived, so the scrubber's literal rule covers it too."""
    return f"{settings.passphrase}-rotated"


def _under(passphrase: str) -> dict[str, str]:
    """Environment override that makes one command run with another passphrase."""
    return {"ATLAS_ENCRYPTION_PASSPHRASE": passphrase}


@pytest.fixture(scope="module", autouse=True)
def _restore_the_session_passphrase(cli: Cli, settings: Settings) -> Iterator[None]:
    """Rotates back if a test failed between the two rotations."""
    yield
    if STATE["rotated"]:
        cli.run(
            "keys",
            "rewrap",
            "--new-passphrase",
            stdin=settings.passphrase,
            extra_env=_under(_rotated_passphrase(settings)),
        )


def test_01_rewrap_without_flags_keeps_the_passphrase(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """A bare `keys rewrap` refreshes the wrapper and every snapshot stays readable."""
    assert storage.object_version_ids(s3, settings.bucket, DEK_KEY), "the bucket holds no data key"

    cli.ok("keys", "rewrap")
    cli.ok("outlook", "list", "-m", settings.mailbox)


def test_02_rewrap_moves_the_key_to_a_new_passphrase(cli: Cli, settings: Settings) -> None:
    """After a rotation the new passphrase opens the bucket and the old one exits 5.

    The suite's passphrase comes from the environment, so the command changes the wrapper and
    leaves the configuration to the caller. Each later command picks its passphrase explicitly.
    """
    rotated = _rotated_passphrase(settings)
    cli.ok("keys", "rewrap", "--new-passphrase", stdin=rotated)
    STATE["rotated"] = True

    cli.ok("outlook", "list", "-m", settings.mailbox, extra_env=_under(rotated))
    stale = cli.run("outlook", "list", "-m", settings.mailbox)
    assert stale.code == EXIT_WRONG_PASSPHRASE, stale.describe()


def test_03_a_snapshot_still_verifies_under_the_new_passphrase(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """The data key did not change: a full verify decrypts every object after the rotation."""
    owner = storage.owner_segments(s3, settings.bucket, "outlook")[0]
    snapshot = storage.snapshot_ids(s3, settings.bucket, owner)[0]

    cli.ok(
        "outlook",
        "verify",
        "-m",
        settings.mailbox,
        "-s",
        snapshot,
        extra_env=_under(_rotated_passphrase(settings)),
    )


def test_04_purge_removes_the_wrappers_the_old_passphrase_opens(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """`keys purge-old-wrappers` leaves exactly one version of the wrapped key."""
    assert len(storage.object_version_ids(s3, settings.bucket, DEK_KEY)) > 1, (
        "the rotation left no old wrapper version to purge"
    )

    cli.ok(
        "keys",
        "purge-old-wrappers",
        "-y",
        "--old-passphrase",
        stdin=settings.passphrase,
        extra_env=_under(_rotated_passphrase(settings)),
    )

    assert len(storage.object_version_ids(s3, settings.bucket, DEK_KEY)) == 1, (
        "an old wrapper version survived the purge"
    )


def test_05_rotating_back_restores_the_session_passphrase(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """Rotates to the original passphrase and purges again, so the later suites see one wrapper."""
    rotated = _rotated_passphrase(settings)
    cli.ok(
        "keys", "rewrap", "--new-passphrase", stdin=settings.passphrase, extra_env=_under(rotated)
    )
    STATE["rotated"] = False

    cli.ok("outlook", "list", "-m", settings.mailbox)
    cli.ok("keys", "purge-old-wrappers", "-y", "--old-passphrase", stdin=rotated)
    assert len(storage.object_version_ids(s3, settings.bucket, DEK_KEY)) == 1
