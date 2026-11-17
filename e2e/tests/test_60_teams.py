"""Teams: back up one team's channel messages, verify, export, and delete a snapshot.

Unlike every other suite, this one seeds nothing. Posting a channel message needs a signed-in user
or the import permission Atlas deliberately does not hold, so the team named by `E2E_TEAM_ID` has to
exist already and hold at least one channel message. The suite reads it and never writes to it.

Teams has no restore, so the lifecycle ends at the export.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _requires_team(settings: Settings) -> None:
    """Skips the whole module when no team is configured."""
    if not settings.team_id:
        pytest.skip("E2E_TEAM_ID not set")


def test_01_list_teams_reaches_graph(cli: Cli) -> None:
    """`teams list-teams` lists what the application can read."""
    cli.ok("teams", "list-teams")


def test_02_backup_writes_an_index_and_messages(cli: Cli, settings: Settings, s3: Any) -> None:
    """A first run stores a snapshot index, channel shards and at least one message object.

    Exit 0 also asserts the team is healthy: a channel error would exit 2.
    """
    cli.ok("teams", "backup", "--team", settings.team_id)

    teams = storage.owner_segments(s3, settings.bucket, "teams")
    assert len(teams) == 1, f"expected one backed-up team, found {len(teams)}"
    STATE["team"] = teams[0]

    snapshots = storage.snapshot_ids(s3, settings.bucket, teams[0], "teams")
    assert len(snapshots) == 1, f"expected one Teams snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]

    assert storage.list_keys(s3, settings.bucket, f"teams/shards/{teams[0]}/"), "no channel shard"
    assert storage.list_keys(s3, settings.bucket, f"teams/data/{teams[0]}/"), (
        "no message object was written; the team needs at least one channel message"
    )


def test_03_list_verify_and_status_read_the_snapshot(cli: Cli, settings: Settings) -> None:
    """The read commands agree the snapshot is intact."""
    cli.ok("teams", "list-snapshots", "--team", settings.team_id)
    cli.ok("teams", "verify", "--team", settings.team_id, "-s", STATE["snapshot"])

    status = cli.ok("teams", "status")
    assert STATE["snapshot"] in status.out, status.describe()


def test_04_an_unchanged_team_stores_no_new_message(cli: Cli, settings: Settings, s3: Any) -> None:
    """A second run resumes the channel delta links and writes no message object again."""
    prefix = f"teams/data/{STATE['team']}/"
    before = storage.list_keys(s3, settings.bucket, prefix)

    cli.ok("teams", "backup", "--team", settings.team_id)

    assert storage.list_keys(s3, settings.bucket, prefix) == before, (
        "an incremental run rewrote or added message objects for an unchanged team"
    )


def test_05_save_exports_a_browsable_archive(
    cli: Cli, settings: Settings, exports: Path, run_marker: str
) -> None:
    """`teams save` writes a zip from storage alone, with an HTML page to open."""
    archive = exports / f"{run_marker}-teams.zip"
    cli.ok(
        "teams",
        "save",
        "--team",
        settings.team_id,
        "-s",
        STATE["snapshot"],
        "--output",
        str(archive),
    )

    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        assert any(n.endswith(".html") for n in names), names


def test_06_snapshot_delete_keeps_the_messages(cli: Cli, settings: Settings, s3: Any) -> None:
    """`teams delete -s` drops one index and keeps the objects other snapshots may reference."""
    prefix = f"teams/data/{STATE['team']}/"
    before = storage.list_keys(s3, settings.bucket, prefix)
    snapshots = storage.snapshot_ids(s3, settings.bucket, STATE["team"], "teams")

    cli.ok("teams", "delete", "--team", settings.team_id, "-s", snapshots[-1], "-y")

    assert snapshots[-1] not in storage.snapshot_ids(s3, settings.bucket, STATE["team"], "teams")
    assert storage.list_keys(s3, settings.bucket, prefix) == before, (
        "a snapshot delete removed message objects"
    )
