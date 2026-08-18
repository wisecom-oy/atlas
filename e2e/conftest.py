"""Fixtures only. Every test's setup and teardown is declared here so suites stay readable."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Iterator

import pytest

from atlas_e2e import cleanup, config, marker, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.graph import Graph

log = logging.getLogger(__name__)


@pytest.fixture(scope="session")
def settings() -> config.Settings:
    """Typed environment. Fails the session immediately when a secret is missing."""
    return config.load()


@pytest.fixture(scope="session")
def run_marker() -> str:
    """The tag every artifact of this run embeds, e.g. `atlas-e2e-1234567890`."""
    tag = marker.marker(marker.new_run_id())
    log.info("Run marker: %s", tag)
    return tag


@pytest.fixture(scope="session")
def atlas_home(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Throwaway HOME for the CLI, so no local secure store or keyring is involved."""
    return tmp_path_factory.mktemp("atlas-home")


@pytest.fixture(scope="session")
def cli(settings: config.Settings, atlas_home: Path) -> Cli:
    """The shipped CLI bundle, driven as a subprocess."""
    return Cli(settings, atlas_home)


@pytest.fixture(scope="session")
def s3(settings: config.Settings) -> Any:
    """S3 client for the primary MinIO."""
    return storage.client(settings)


@pytest.fixture(scope="session")
def s3_replica(settings: config.Settings) -> Any:
    """S3 client for the replica MinIO (used by the replication suite)."""
    return storage.client(settings, settings.s3_replica_endpoint)


@pytest.fixture(scope="session")
def graph(settings: config.Settings) -> Iterator[Graph]:
    """Graph client with app-only auth."""
    client = Graph(settings)
    yield client
    client.close()


@pytest.fixture(scope="session")
def exports(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Directory for `atlas outlook save` output.

    Unique per run because `save` prompts before overwriting an existing file and has no bypass
    flag, so a reused path would hang the suite waiting for stdin.
    """
    return tmp_path_factory.mktemp("exports")


@pytest.fixture(scope="session", autouse=True)
def _teardown(
    settings: config.Settings, cli: Cli, graph: Graph, run_marker: str
) -> Iterator[None]:
    """Sweeps M365 fixtures and empties the tenant bucket after the session, pass or fail.

    Teardown never raises: an exception here would replace the real test failure with a cleanup
    error. Anything it could not remove is logged, and the next run's stale sweep collects it.
    """
    yield
    log.info("Teardown: sweeping %s", run_marker)
    try:
        removed = cleanup.sweep_mailbox(graph, settings.mailbox, run_marker)
        log.info("Teardown: removed %d mailbox folder(s)", len(removed))
    except Exception as err:  # noqa: BLE001 - teardown must not mask a test failure
        log.warning("Teardown: mailbox sweep failed: %s", err)
    cleanup.purge_bucket(cli)
