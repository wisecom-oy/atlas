"""SDK operations with progress and cancellation: backup, verify, read and a one-message restore.

Runs after `test_36_sdk.py` (file order) on the snapshots `test_10` and `test_12` left. Backups
are scoped to the run's fixture folder, as the CLI suites are. They may add Outlook snapshots,
never remove one, and every snapshot is verified clean before this module ends, so `test_80`
still finds one to verify. The restore writes one message under `<marker>-sdk`, a top-level
folder the mailbox sweep removes.
"""

from __future__ import annotations

from typing import Any

import pytest

from atlas_e2e import probe, sdk
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph

STATE: dict[str, Any] = {}


@pytest.fixture(scope="module", autouse=True)
def _outlook_owner(settings: Settings, s3: Any) -> None:
    """Reads the one mailbox owner segment the Outlook suites backed up."""
    STATE["owner"] = sdk.sole_owner(s3, settings, "outlook")
    assert _snapshots(settings, s3), "test_10_outlook left no snapshot to work on"


def _snapshots(settings: Settings, s3: Any) -> set[str]:
    """Outlook snapshot ids of the fixture mailbox, read from the manifest key names."""
    return sdk.snapshots_of(s3, settings, STATE["owner"])


def _backup(settings: Settings, run_marker: str, abort_on: str = "") -> dict[str, Any]:
    """Runs `backup.mjs` over the fixture folder, aborting on phase `abort_on` when it is set."""
    env = {"E2E_MAILBOX": settings.mailbox, "E2E_RUN_MARKER": run_marker, "E2E_ABORT_ON": abort_on}
    return sdk.ok(settings, "backup.mjs", env)


def test_01_an_already_aborted_signal_does_no_work(
    settings: Settings, s3: Any, run_marker: str
) -> None:
    """Verify and backup resolve interrupted with `finalizing`, `interrupted` and no S3 request."""
    before = _snapshots(settings, s3)
    data = sdk.ok(
        settings,
        "pre-aborted.mjs",
        {
            "E2E_OWNER_ID": STATE["owner"],
            "E2E_SNAPSHOT_ID": sorted(before)[0],
            "E2E_RUN_MARKER": run_marker,
        },
    )
    for operation in ("verify", "backup"):
        outcome = data[operation]
        assert outcome["interrupted"], f"{operation} did not report the interruption"
        assert outcome["phases"] == ["finalizing", "interrupted"], outcome["phases"]
        assert outcome["storage_requests"] == 0, f"{operation} sent S3 requests"
    assert data["verify"]["total_checked"] == 0
    assert data["backup"]["snapshot_stored"] is False
    assert data["backup"]["stored"] == 0
    assert _snapshots(settings, s3) == before, "an aborted backup wrote a snapshot"


def test_02_backup_reports_progress_and_completes(
    settings: Settings, s3: Any, run_marker: str
) -> None:
    """A scoped SDK backup emits a well-formed event stream and reports the snapshot it left.

    The scope also matches the restored copies `test_10` and `test_12` created, so this run may
    store them; whatever it writes must be the one snapshot it reports.
    """
    before = _snapshots(settings, s3)
    data = _backup(settings, run_marker)

    problems = sdk.progress_problems(data["events"], "backup", "outlook")
    assert not problems, problems
    run_phases = sdk.phases(data["events"])
    assert run_phases[0] == "discovering" and run_phases[-1] == "completed", run_phases
    assert not data["interrupted"] and data["snapshot_stored"]
    assert data["folder_errors"] == 0, f"{data['folder_errors']} folder error(s)"
    assert data["graph_cost_reported"], "the result has no graphCost"

    after = _snapshots(settings, s3)
    assert before <= after, "a backup removed an existing snapshot"
    assert after - before <= {data["snapshot_id"]}, (
        "a snapshot other than the reported one appeared"
    )
    assert data["snapshot_id"] in after, "the reported snapshot is not in the bucket"


def test_03_a_backup_with_nothing_new_stores_nothing(
    settings: Settings, s3: Any, run_marker: str
) -> None:
    """Straight after `test_02`, the scope holds no change: nothing stored, no snapshot written."""
    before = _snapshots(settings, s3)
    data = _backup(settings, run_marker)

    assert sdk.phases(data["events"])[-1] == "completed"
    assert not data["interrupted"]
    assert data["mode"] == "incremental", data["mode"]
    assert data["stored"] == 0, f"{data['stored']} message(s) stored by a quiet run"
    assert _snapshots(settings, s3) == before, "a run that captured nothing wrote a snapshot"
    assert data["snapshot_id"] in before, "a quiet run must report the existing newest snapshot"


def test_04_aborting_mid_run_interrupts_without_a_snapshot(
    settings: Settings, s3: Any, run_marker: str
) -> None:
    """Aborting on the first `processing` event stops before any folder and writes no snapshot.

    The abort fires inside the progress callback, after folder discovery and before the folder
    loop first checks the signal, so the stopping point is fixed rather than a race.
    """
    before = _snapshots(settings, s3)
    data = _backup(settings, run_marker, abort_on="processing")

    assert not sdk.progress_problems(data["events"], "backup", "outlook")
    assert sdk.phases(data["events"]) == ["discovering", "processing", "finalizing", "interrupted"]
    assert data["interrupted"], "the result does not say the run was interrupted"
    assert _snapshots(settings, s3) == before, "an interrupted run wrote a snapshot"


def test_05_verify_passes_deep_and_fast_on_every_snapshot(settings: Settings, s3: Any) -> None:
    """Every Outlook snapshot, including those written above, verifies clean in both modes."""
    snapshots = sorted(_snapshots(settings, s3))
    data = sdk.ok(settings, "verify.mjs", {"E2E_SNAPSHOT_IDS": ",".join(snapshots)})

    assert len(data["results"]) == len(snapshots)
    for result in data["results"]:
        deep, fast = result["deep"], result["fast"]
        for report in (deep, fast):
            assert report["failed"] == 0 and report["unverifiable"] == 0, report
            assert report["total_checked"] == report["passed"] > 0, report
            assert report["manifests_in_chain"] >= 1 and not report["interrupted"], report
            assert not sdk.progress_problems(report["events"], "verify", "outlook")
            assert sdk.phases(report["events"])[-1] == "completed"
        assert deep["total_checked"] == fast["total_checked"]


def test_06_read_message_returns_the_stored_mime(settings: Settings, run_marker: str) -> None:
    """`readMessage` decrypts the seeded MIME; an unknown snapshot reads as `undefined`."""
    data = sdk.ok(
        settings,
        "read-message.mjs",
        {
            "E2E_OWNER_ID": STATE["owner"],
            "E2E_RUN_MARKER": run_marker,
            "E2E_UNKNOWN_SNAPSHOT": "00000000-0000-0000-0000-000000000000",
        },
    )
    found = [m for m in data["messages"] if m["found"]]
    assert found, "no snapshot resolved message 1"
    assert all(m["mime"] and m["payload_format"] == "mime" for m in found)
    seeded = [m for m in found if str(m["subject"]).startswith(f"{run_marker}-mail-")]
    assert seeded, "no message 1 carries a seeded subject"
    STATE["message"] = seeded[0]
    assert data["unknown_message_is_undefined"] and data["unknown_detail_is_undefined"]


def test_07_one_message_restores_into_the_destination(
    settings: Settings, graph: Graph, run_marker: str
) -> None:
    """A single-message restore lands under `<marker>-sdk`, which the mailbox sweep removes."""
    destination = f"{run_marker}-sdk"
    data = sdk.ok(
        settings,
        "restore-message.mjs",
        {"E2E_SNAPSHOT_ID": STATE["message"]["snapshot_id"], "E2E_DESTINATION": destination},
    )
    assert data["restored_count"] == 1 and data["reports"] == 1, data
    assert data["error_count"] == data["attachment_error_count"] == data["attachments_failed"] == 0
    assert not data["interrupted"]
    assert not sdk.progress_problems(data["events"], "restore", "outlook")
    assert sdk.phases(data["events"])[-1] == "completed"

    root = probe.find_top_level_folder(graph, settings.mailbox, destination)
    assert root, f"no top-level folder named {destination}"
    subject = STATE["message"]["subject"]
    assert probe.find_message_in_tree(graph, settings.mailbox, str(root["id"]), subject), (
        "the restored message is not under the destination"
    )
