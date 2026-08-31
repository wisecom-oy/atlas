"""Run tagging. Every artifact the suite creates carries a marker; cleanup trusts nothing else."""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime, timedelta

PREFIX = "atlas-e2e"

# A run that dies mid-flight (runner killed, Graph outage) leaks fixtures. The next run sweeps
# anything marked and older than this, so leftovers are bounded by a week, not by memory.
STALE_AFTER = timedelta(hours=24)


def new_run_id() -> str:
    """GitHub run id in CI, wall-clock epoch locally. Unique per run either way."""
    return os.environ.get("GITHUB_RUN_ID") or f"local-{int(time.time())}"


def marker(run_id: str) -> str:
    """The name every artifact of this run embeds."""
    return f"{PREFIX}-{run_id}"


def is_marked(name: str | None) -> bool:
    """Whether a name belongs to some E2E run. Cleanup deletes only what this accepts."""
    return bool(name) and name.startswith(PREFIX)  # type: ignore[union-attr]


def is_stale(created: datetime | None) -> bool:
    """Whether a marked artifact is old enough that no live run can still own it."""
    if created is None:
        return False
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return datetime.now(UTC) - created > STALE_AFTER


def parse_graph_time(value: str | None) -> datetime | None:
    """Parses a Graph ISO-8601 timestamp; returns None when absent or unparseable."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
