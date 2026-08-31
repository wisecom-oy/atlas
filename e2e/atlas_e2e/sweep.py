"""Standalone teardown: `python -m atlas_e2e.sweep`.

pytest already sweeps in a session fixture. This exists for the workflow's `if: always()` step,
which has to clean up after a crashed interpreter or a cancelled job -- cases where no fixture runs.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable

from atlas_e2e import cleanup, config, drive, marker
from atlas_e2e.atlas import Cli
from atlas_e2e.graph import Graph


def main() -> int:
    """Sweeps marked M365 fixtures and empties the tenant bucket.

    Returns non-zero only when this run's own drive artifacts survived the sweep. Test outcomes are
    a separate step, so failing here reports a cleanup problem without touching them, and a silent
    leftover is what let the tenant accumulate duplicates of its own fixtures.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    log = logging.getLogger("sweep")
    try:
        settings = config.load()
    except RuntimeError as err:
        log.warning("Nothing to sweep: %s", err)
        return 0

    tag = marker.marker(marker.new_run_id())
    graph = Graph(settings)
    try:
        removed = cleanup.sweep_mailbox(graph, settings.mailbox, tag)
        log.info("Removed %d mailbox folder(s)", len(removed))
    except Exception as err:  # noqa: BLE001 - a failed sweep must not fail the job after the tests
        log.warning("Mailbox sweep failed: %s", err)

    survivors: list[str] = []
    resolvers: tuple[tuple[str, Callable[[], str]], ...] = (
        ("onedrive", lambda: drive.user_drive_id(graph, settings.onedrive_owner)),
        (
            "sharepoint",
            lambda: drive.site_drive_id(graph, drive.site_id(graph, settings.sharepoint_site)),
        ),
    )
    for label, resolve in resolvers:
        configured = settings.onedrive_owner if label == "onedrive" else settings.sharepoint_site
        if not configured:
            continue
        try:
            drive_id = resolve()
            removed = cleanup.sweep_drive(graph, drive_id, tag)
            log.info("Removed %d %s item(s)", len(removed), label)
            left = cleanup.surviving_drive_artifacts(graph, drive_id, tag)
            if left:
                log.error("%s still holds this run's artifacts: %s", label, left)
                survivors.extend(f"{label}:{name}" for name in left)
        except Exception as err:  # noqa: BLE001 - same rule as above
            log.warning("%s sweep failed: %s", label, err)

    graph.close()

    # Purge is independent of Graph: an unreachable tenant must not leave the bucket populated.
    cleanup.purge_bucket(Cli(settings, config.REPO_ROOT / "e2e" / ".sweep-home"), settings)

    if survivors:
        log.error("Cleanup incomplete; %d artifact(s) survived", len(survivors))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
