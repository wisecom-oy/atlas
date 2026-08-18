"""Fixtures only. Every test's setup and teardown is declared here so suites stay readable."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Iterator

import pytest

from atlas_e2e import cleanup, config, drive, marker, scrub as scrub_module, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.graph import Graph

log = logging.getLogger(__name__)


@pytest.fixture(scope="session")
def settings() -> config.Settings:
    """Typed environment. Fails the session immediately when a secret is missing."""
    return config.load()


@pytest.fixture(scope="session", autouse=True)
def _scrub_every_log_record(settings: config.Settings) -> Iterator[None]:
    """Routes every log record through the scrubber, whoever emitted it.

    Our own log lines are easy to keep clean; third-party ones are not. `httpx` logs each request
    URL at INFO, and a SharePoint download URL contains a signed `tempauth` token, the tenant host
    and the owner's personal-site path. Those reached a public Actions log before this existed.

    Patching `LogRecord.getMessage` catches them all at the one point every handler and formatter
    goes through -- a filter would have to be attached to each handler, including the ones pytest
    creates for `log_cli` after this fixture runs.
    """
    original = logging.LogRecord.getMessage

    def scrubbed(record: logging.LogRecord) -> str:
        return scrub_module.scrub(original(record), settings)

    logging.LogRecord.getMessage = scrubbed  # type: ignore[method-assign]
    try:
        yield
    finally:
        logging.LogRecord.getMessage = original  # type: ignore[method-assign]


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
    """The shipped CLI bundle, driven as a subprocess, recording a scrubbed transcript.

    The transcript is what an operator triaging a red weekly run actually wants: every command the
    suite issued and what came back. It is uploaded as an artifact, so it is scrubbed on write.
    """
    return Cli(settings, atlas_home, transcript=config.REPO_ROOT / "e2e" / "logs" / "cli.log")


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

    for label, drive_id in _fixture_drives(graph, settings).items():
        try:
            removed = cleanup.sweep_drive(graph, drive_id, run_marker)
            log.info("Teardown: removed %d %s folder(s)", len(removed), label)
        except Exception as err:  # noqa: BLE001 - same rule as above
            log.warning("Teardown: %s sweep failed: %s", label, err)

    cleanup.purge_bucket(cli, settings)


def _fixture_drives(graph: Graph, settings: config.Settings) -> dict[str, str]:
    """Drive ids the suite may have seeded into. Absent configuration yields no entry."""
    drives: dict[str, str] = {}
    if settings.onedrive_owner:
        try:
            drives["onedrive"] = drive.user_drive_id(graph, settings.onedrive_owner)
        except Exception as err:  # noqa: BLE001 - resolution failure must not break teardown
            log.warning("Teardown: could not resolve the OneDrive drive: %s", err)
    if settings.sharepoint_site:
        try:
            drives["sharepoint"] = drive.site_drive_id(graph, drive.site_id(graph, settings.sharepoint_site))
        except Exception as err:  # noqa: BLE001 - same rule as above
            log.warning("Teardown: could not resolve the SharePoint library: %s", err)
    return drives
