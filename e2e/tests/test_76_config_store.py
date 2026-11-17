"""`atlas config`: the encrypted local store for shared settings, in a home of its own.

The suite's `Cli` always sets the S3 and passphrase variables, and environment variables win over
the store (`load_config`, `read_sources` in `config.command.ts`). An empty `ATLAS_*` value counts as
unset there, so each read that must come from the store blanks its variable through `extra_env`.

The store's key goes to the OS keyring when `secret-tool` or the macOS keychain exists and to
`~/.atlas/config.key` otherwise, which is what a CI runner uses. The suite never decrypts the store
itself: that would be a second copy of the product's format. What the store holds is read back
through the CLI, and `test_05` proves a stored value is the one a command then runs with.

Reads the bucket `test_10` wrote, read-only, and runs before `test_80_keys` rotates its passphrase.
"""

from __future__ import annotations

import secrets
import stat
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import config, exits
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

OWNER_ONLY = 0o600

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module")
def home(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """An empty home, so the store this module writes is the only one any command sees."""
    return tmp_path_factory.mktemp("atlas-config-home")


@pytest.fixture(scope="module")
def store_cli(settings: Settings, home: Path) -> Cli:
    """A CLI without the Graph identity: `atlas config` never needs it."""
    return Cli(settings, home, transcript=_transcript(), graph_env=False)


@pytest.fixture(scope="module")
def run_cli(settings: Settings, home: Path) -> Cli:
    """The same home with the Graph identity set, for commands that load the full configuration."""
    return Cli(settings, home, transcript=_transcript())


def _transcript() -> Path:
    return config.REPO_ROOT / "e2e" / "logs" / "cli.log"


def _store(home: Path) -> Path:
    return home / ".atlas" / "config.enc"


def _key_file(home: Path) -> Path:
    return home / ".atlas" / "config.key"


def _blank(*variables: str) -> dict[str, str]:
    """Environment override that unsets variables for one command, so the store answers."""
    return dict.fromkeys(variables, "")


def test_01_a_secret_set_from_stdin_is_masked(store_cli: Cli) -> None:
    """`config set s3.secret-key -` reads stdin, and `get` and `list` print only the last four.

    The mask is only visible in the command's output, so a known string is the assertion here.
    The value is random hex, not a credential: S3 keeps using the environment's secret.
    """
    secret = secrets.token_hex(16)
    STATE["secret"] = secret
    store_cli.ok("config", "set", "s3.secret-key", "-", stdin=secret)

    for argv in (("config", "get", "s3.secret-key"), ("config", "list")):
        result = store_cli.ok(*argv, extra_env=_blank("ATLAS_S3_SECRET_KEY"))
        assert secret not in result.out, f"`atlas {' '.join(argv)}` printed the secret"
        assert f"****{secret[-4:]}" in result.out, result.describe()


def test_02_the_store_file_holds_no_plaintext(home: Path) -> None:
    """The secret is not in `config.enc`, and the store and its key file are owner-only."""
    store = _store(home)
    assert store.exists(), "config set wrote no store"
    assert STATE["secret"].encode() not in store.read_bytes(), "the store holds the plaintext"
    assert stat.S_IMODE(store.stat().st_mode) == OWNER_ONLY, oct(store.stat().st_mode)

    if _key_file(home).exists():
        assert stat.S_IMODE(_key_file(home).stat().st_mode) == OWNER_ONLY


def test_03_a_bad_value_is_refused_and_not_stored(store_cli: Cli, home: Path) -> None:
    """Format validation runs before the write: exit 1, store bytes unchanged."""
    before = _store(home).read_bytes()
    for key, value in (("s3.region", "Not A Region"), ("s3.endpoint", "ftp://example.com")):
        result = store_cli.run("config", "set", key, value)
        assert result.code == exits.EXIT_FAILURE, result.describe()
    short = store_cli.run("config", "set", "encryption.passphrase", "-", stdin="x")
    assert short.code == exits.EXIT_FAILURE, short.describe()
    assert _store(home).read_bytes() == before, "a refused value changed the store"


def test_04_tenant_and_bucket_keys_are_refused(store_cli: Cli, home: Path) -> None:
    """Credentials belong to tenant profiles and a bucket to one tenant, so all five are refused."""
    before = _store(home).read_bytes()
    for key in ("tenant.id", "client.id", "client.secret", "bucket", "s3.bucket"):
        for argv in (("set", key, "unused"), ("get", key), ("unset", key)):
            result = store_cli.run("config", *argv)
            assert result.code == exits.EXIT_FAILURE, result.describe()
    assert _store(home).read_bytes() == before, "a refused key changed the store"


def test_05_the_stored_passphrase_opens_the_bucket(
    store_cli: Cli, run_cli: Cli, settings: Settings
) -> None:
    """A command takes the passphrase from the store when the variable is unset, else from env.

    A wrong stored passphrase exits 5 on its own and is ignored while the variable is set, which
    is the precedence `load_config` documents.
    """
    unset = _blank("ATLAS_ENCRYPTION_PASSPHRASE")
    store_cli.ok("config", "set", "encryption.passphrase", "-", stdin=settings.passphrase)
    run_cli.ok("outlook", "list", extra_env=unset)

    store_cli.ok(
        "config", "set", "encryption.passphrase", "-", stdin=exits.wrong(settings.passphrase)
    )
    stale = run_cli.run("outlook", "list", extra_env=unset)
    assert stale.code == exits.EXIT_WRONG_PASSPHRASE, stale.describe()
    run_cli.ok("outlook", "list")


def test_06_unset_removes_values(store_cli: Cli, home: Path) -> None:
    """`unset` drops one key; dropping the last one deletes the store file."""
    store_cli.ok("config", "set", "s3.region", "eu-north-1")
    store_cli.ok("config", "unset", "s3.region")

    region = store_cli.ok("config", "get", "s3.region", extra_env=_blank("ATLAS_S3_REGION"))
    assert "eu-north-1" not in region.out, "unset left the value in the store"
    secret = store_cli.ok("config", "get", "s3.secret-key", extra_env=_blank("ATLAS_S3_SECRET_KEY"))
    assert f"****{STATE['secret'][-4:]}" in secret.out, "unset removed another key"

    store_cli.ok("config", "unset", "s3.secret-key")
    store_cli.ok("config", "unset", "encryption.passphrase")
    assert not _store(home).exists(), "an emptied store was left on disk"
    store_cli.ok("config", "unset", "s3.region")


def test_07_validate_probes_the_effective_storage(store_cli: Cli, settings: Settings) -> None:
    """`config validate` lists buckets with the effective S3 settings and exits 1 when it cannot.

    Without a tenant id there is no bucket to bind `ATLAS_S3_BUCKET` to, which is refused too.
    """
    store_cli.ok("config", "validate")

    wrong_secret = {"ATLAS_S3_SECRET_KEY": exits.wrong(settings.s3_secret_key)}
    for env in (wrong_secret, {"ATLAS_S3_BUCKET": settings.bucket}):
        result = store_cli.run("config", "validate", extra_env=env)
        assert result.code == exits.EXIT_FAILURE, result.describe()
