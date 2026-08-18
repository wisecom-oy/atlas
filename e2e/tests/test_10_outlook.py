"""Outlook lifecycle: seed, back up, export, destroy in M365, restore, prove it came back.

The tests run in file order and share `STATE`, because the lifecycle is a sequence -- a restore
cannot be asserted before a backup exists. Later steps fail loudly rather than being skipped, so a
broken middle step is visible instead of silently green.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

from atlas_e2e import probe, seed, storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph

STATE: dict[str, Any] = {}


def test_01_seed_folder_and_message(graph: Graph, settings: Settings, run_marker: str) -> None:
    """Creates the fixture folder and one message with a random binary attachment."""
    folder_id = seed.create_folder(graph, settings.mailbox, run_marker)
    message = seed.create_message(graph, settings.mailbox, folder_id, run_marker, 1)

    STATE["folder_id"] = folder_id
    STATE["first"] = message

    assert probe.find_message_in_tree(graph, settings.mailbox, folder_id, message.subject)


def test_02_initial_backup_writes_objects(cli: Cli, settings: Settings, s3: Any, run_marker: str) -> None:
    """Backs up only the fixture folder and asserts real objects landed in the bucket.

    `-f <marker>` is mandatory: a bare backup would enumerate every mailbox in the tenant.
    """
    result = cli.ok("outlook", "backup", "-m", settings.mailbox, "-f", run_marker)
    assert "Resuming incremental sync" not in result.out, "first run must be an initial sync"

    owner = _owner_id(s3, settings.bucket)
    STATE["owner"] = owner

    snapshots = storage.snapshot_ids(s3, settings.bucket, owner)
    assert len(snapshots) == 1, f"expected one snapshot, found {snapshots}"
    STATE["snapshot"] = snapshots[0]

    assert storage.list_keys(s3, settings.bucket, f"data/{owner}/"), "no message blob was written"
    assert storage.list_keys(s3, settings.bucket, f"attachments/{owner}/"), "no attachment blob written"


def test_03_list_reads_the_catalog(cli: Cli, settings: Settings) -> None:
    """`outlook list` reads the manifest chain for the mailbox without error."""
    cli.ok("outlook", "list", "-m", settings.mailbox)


def test_04_verify_passes_on_a_fresh_snapshot(cli: Cli, settings: Settings) -> None:
    """Deep verification: every blob is downloaded, decrypted, re-hashed, compared."""
    cli.ok("outlook", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"])


def test_05_save_exports_an_eml_archive(cli: Cli, exports: Path, run_marker: str) -> None:
    """`outlook save` produces a zip containing the message as `.eml`."""
    archive = exports / f"{run_marker}.zip"
    cli.ok("outlook", "save", "-s", STATE["snapshot"], "-o", str(archive))

    assert archive.exists(), f"{archive} was not written"
    with zipfile.ZipFile(archive) as zf:
        assert [n for n in zf.namelist() if n.endswith(".eml")], zf.namelist()


def test_06_incremental_backup_adds_only_the_new_message(
    cli: Cli, graph: Graph, settings: Settings, s3: Any, run_marker: str
) -> None:
    """A second run resumes from saved delta state and stores exactly the newly seeded message.

    Ordered before the restore on purpose. A `--folder` selector matches a bare folder name at any
    depth, so the restored copy at `Restore-<ts>/atlas-e2e-<run>/` would re-enter backup scope and a
    later incremental run would legitimately store two new blobs. Measuring the delta first keeps
    this assertion exact instead of approximate.
    """
    owner = STATE["owner"]
    before = set(storage.list_keys(s3, settings.bucket, f"data/{owner}/"))

    STATE["second"] = seed.create_message(graph, settings.mailbox, STATE["folder_id"], run_marker, 2)

    result = cli.ok("outlook", "backup", "-m", settings.mailbox, "-f", run_marker)
    assert "Resuming incremental sync" in result.out, result.describe()

    after = set(storage.list_keys(s3, settings.bucket, f"data/{owner}/"))
    assert len(after - before) == 1, f"expected exactly one new message blob, got {len(after - before)}"
    assert before <= after, "an incremental run must not remove existing blobs"

    snapshots = storage.snapshot_ids(s3, settings.bucket, owner)
    assert len(snapshots) == 2, f"expected a second snapshot, found {snapshots}"


def test_07_restore_recreates_a_deleted_message(
    cli: Cli, graph: Graph, settings: Settings, run_marker: str
) -> None:
    """Deletes the message from M365, restores it, and confirms Graph can see it again.

    This is the assertion the whole pipeline exists for: the data is proven present in the mailbox,
    not merely reported as restored by the tool that wrote it.
    """
    message = STATE["first"]
    probe.delete_message(graph, settings.mailbox, message.message_id)
    assert probe.find_message_in_tree(graph, settings.mailbox, STATE["folder_id"], message.subject) is None

    cli.ok("outlook", "restore", "-s", STATE["snapshot"])

    # Restore rebuilds the source tree under `Restore-{timestamp}`, so the fixture folder name is
    # what identifies our root among any restores an operator made by hand.
    roots = probe.restore_roots_containing(graph, settings.mailbox, run_marker)
    assert roots, "no Restore-* folder holding this run's data was created"
    STATE["restore_root"] = roots[0]


def test_08_restored_attachment_is_byte_identical(graph: Graph, settings: Settings) -> None:
    """The restored attachment hashes to the seeded bytes, and the body keeps its sentinel."""
    message = STATE["first"]
    restored = probe.find_message_in_tree(
        graph, settings.mailbox, str(STATE["restore_root"]["id"]), message.subject
    )
    assert restored, f"restored message {message.subject} not found under the restore root"

    body = str(restored.get("body", {}).get("content", ""))
    assert message.sentinel in body, "restored body lost its sentinel"

    digest = probe.attachment_sha256(graph, settings.mailbox, str(restored["id"]), message.attachment_name)
    assert digest == message.attachment_sha256, "restored attachment does not match the seeded bytes"


def test_09_status_reports_the_backed_up_folder(cli: Cli, settings: Settings, run_marker: str) -> None:
    """`outlook status` peeks at delta state for the mailbox and names the fixture folder."""
    result = cli.ok("outlook", "status", "-m", settings.mailbox)
    assert run_marker in result.out, result.describe()


def test_10_purge_empties_the_bucket(cli: Cli, settings: Settings, s3: Any) -> None:
    """`delete --purge` removes every object including the DEK, leaving nothing retained.

    Governance leg only: the monthly compliance leg owns its own purge assertion (plan section 4.1).
    """
    cli.ok("outlook", "delete", "--purge", "-y")
    assert storage.list_keys(s3, settings.bucket) == [], "purge left objects behind"


def _owner_id(s3: Any, bucket: str) -> str:
    """Reads the owner segment Atlas used from the manifest keys rather than assuming a normalisation."""
    owners = {key.split("/")[1] for key in storage.list_keys(s3, bucket, "manifests/")}
    assert len(owners) == 1, f"expected exactly one backed-up owner, found {sorted(owners)}"
    return owners.pop()
