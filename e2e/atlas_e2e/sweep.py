"""Standalone teardown: `python -m atlas_e2e.sweep`.

pytest already sweeps in a session fixture. This exists for the workflow's `if: always()` step,
which has to clean up after a crashed interpreter or a cancelled job -- cases where no fixture runs.
"""

from __future__ import annotations

import logging
import sys

from atlas_e2e import cleanup, config, drive, marker
from atlas_e2e.atlas import Cli
from atlas_e2e.graph import Graph


def main() -> int:
    """Sweeps marked M365 fixtures and empties the tenant bucket. Never fails the job."""
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

    for label, resolve in (
        ("onedrive", lambda: drive.user_drive_id(graph, settings.onedrive_owner)),
        ("sharepoint", lambda: drive.site_drive_id(graph, drive.site_id(graph, settings.sharepoint_site))),
    ):
        configured = settings.onedrive_owner if label == "onedrive" else settings.sharepoint_site
        if not configured:
            continue
        try:
            removed = cleanup.sweep_drive(graph, resolve(), tag)
            log.info("Removed %d %s folder(s)", len(removed), label)
        except Exception as err:  # noqa: BLE001 - same rule as above
            log.warning("%s sweep failed: %s", label, err)

    graph.close()

    # Purge is independent of Graph: an unreachable tenant must not leave the bucket populated.
    cleanup.purge_bucket(Cli(settings, config.REPO_ROOT / "e2e" / ".sweep-home"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
