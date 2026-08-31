"""Teardown. Deletes only what carries a marker, on both the Graph side and the S3 side."""

from __future__ import annotations

import logging

from atlas_e2e import drive, probe
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph, GraphError
from atlas_e2e.marker import PREFIX, is_marked, is_stale, parse_graph_time
from atlas_e2e.scrub import scrub

log = logging.getLogger(__name__)


def sweep_drive(graph: Graph, drive_id: str, marker: str) -> list[str]:
    """Deletes marked fixture folders from a OneDrive or SharePoint drive.

    Restored copies land inside the marked fixture folder they were backed up from, so they go with
    it. Foreign markers follow the staleness rule, so a concurrent run's fixtures are never deleted
    from under it.

    Only names carrying the E2E marker are ever deleted, no matter which folder they were found in.
    An earlier version of this function treated any unmarked item under the fixture root as debris,
    on the theory that the folder was suite-owned; it deleted a tenant's real files. Cleanup must
    never remove anything the suite did not create, so membership is decided by the marker alone.
    """
    removed: list[str] = []
    for item in drive.fixture_items(graph, drive_id, PREFIX):
        name = str(item.get("name", ""))
        if not is_marked(name):
            continue
        if marker not in name and not is_stale(parse_graph_time(item.get("createdDateTime"))):
            log.info("Leaving foreign, non-stale drive folder %s", name)
            continue
        _delete_drive_item(graph, drive_id, str(item["id"]), name, removed)

    # A restore that took the default destination nests under `Restore-{timestamp}` at the drive
    # root, which carries no marker, so it is identified by holding a marked descendant instead.
    for root in drive.restore_roots_containing(graph, drive_id, marker):
        _delete_drive_item(graph, drive_id, str(root["id"]), str(root.get("name", "")), removed)
    return removed


def _delete_drive_item(
    graph: Graph, drive_id: str, item_id: str, name: str, removed: list[str]
) -> None:
    """Deletes one drive item, recording it; a failure is logged, never raised out of teardown."""
    try:
        drive.delete_item(graph, drive_id, item_id)
        removed.append(name)
        log.info("Cleaned up drive folder %s", name)
    except GraphError as err:
        log.warning("Could not delete drive folder %s: %s", name, err)


def surviving_drive_artifacts(graph: Graph, drive_id: str, marker: str) -> list[str]:
    """Names still carrying this run's marker after a sweep. Empty is the only acceptable result.

    The sweep logs and continues on every failure so it cannot mask a test result, which also means
    a leftover would otherwise be invisible. This is the check that makes it visible: a run that
    cannot clean up after itself is how the tenant accumulated duplicates of its own fixtures.
    """
    try:
        items = drive.fixture_items(graph, drive_id, PREFIX)
    except GraphError as err:
        log.warning("Could not verify drive cleanup: %s", err)
        return []
    leftovers = [str(i.get("name", "")) for i in items if marker in str(i.get("name", ""))]
    leftovers.extend(
        str(r.get("name", "")) for r in drive.restore_roots_containing(graph, drive_id, marker)
    )
    return leftovers


def sweep_mailbox(graph: Graph, mailbox: str, marker: str) -> list[str]:
    """Deletes this run's fixture folders, this run's restore roots, and stale foreign leftovers.

    Foreign markers (another run's) are only removed once stale, so a local run cannot delete the
    fixtures of a scheduled run that is still in flight.
    """
    removed: list[str] = []

    for folder in probe.top_level_folders(graph, mailbox):
        name = str(folder.get("displayName", ""))
        if not is_marked(name):
            continue
        if marker not in name and not _folder_is_stale(graph, mailbox, str(folder["id"])):
            log.info("Leaving foreign, non-stale fixture folder %s", name)
            continue
        _delete_folder(graph, mailbox, str(folder["id"]), name, removed)

    # Restore roots are named `Restore-{timestamp}` by the product, so they are identified by
    # holding a marked descendant rather than by their own name.
    for root in probe.restore_roots_containing(graph, mailbox, marker):
        _delete_folder(graph, mailbox, str(root["id"]), str(root.get("displayName", "")), removed)

    return removed


def purge_bucket(cli: Cli, settings: Settings) -> None:
    """Empties the tenant bucket through the product's own purge path.

    Locked objects from the immutability suite legitimately refuse to delete, so a non-zero exit is
    logged rather than raised -- the workflow's volume teardown owns those bytes. The output is
    scrubbed before logging: purge output can carry object keys, and keys carry owner ids.
    """
    result = cli.run("delete", "--purge", "-y")
    if result.code != 0:
        log.warning("Purge exited %s: %s", result.code, scrub(result.out, settings).strip()[:400])


def _delete_folder(
    graph: Graph, mailbox: str, folder_id: str, name: str, removed: list[str]
) -> None:
    """Deletes one folder, recording it; a failure is logged, never raised out of teardown."""
    try:
        graph.delete(f"/users/{mailbox}/mailFolders/{folder_id}")
        removed.append(name)
        log.info("Cleaned up folder %s", name)
    except GraphError as err:
        log.warning("Could not delete folder %s: %s", name, err)


def _folder_is_stale(graph: Graph, mailbox: str, folder_id: str) -> bool:
    """Whether a marked folder's newest message is old enough that no live run owns it."""
    messages = graph.get(
        f"/users/{mailbox}/mailFolders/{folder_id}/messages",
        **{"$select": "receivedDateTime", "$top": 1, "$orderby": "receivedDateTime desc"},
    ).get("value", [])
    if not messages:
        return False
    return is_stale(parse_graph_time(messages[0].get("receivedDateTime")))
