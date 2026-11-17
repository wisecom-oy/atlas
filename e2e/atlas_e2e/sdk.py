"""Runs the SDK scenario scripts in `e2e/sdk/` against the published SDK bundle.

Each script imports `packages/sdk/dist/index.mjs`, the file that goes to npm, and prints one JSON
document. Both output streams are scrubbed before they are stored on the result, the way
`atlas.Cli` treats CLI output: a failing script's message can name a mailbox or an object path.

The parsed document is taken from the raw stdout, not the scrubbed text, because it carries the
snapshot ids the tests compare with S3 key names, and the GUID rule in `scrub` would turn every id
into the same placeholder. The scripts print only counts, booleans, snapshot ids, error codes and
names that contain the run marker. Assertion messages use `describe()` or counts, never `data`.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from atlas_e2e import storage
from atlas_e2e.config import REPO_ROOT, Settings
from atlas_e2e.scrub import MIN_LITERAL_LENGTH, scrub

log = logging.getLogger(__name__)

SCRIPT_DIR = REPO_ROOT / "e2e" / "sdk"
BUNDLE = REPO_ROOT / "packages" / "sdk" / "dist" / "index.mjs"
DEFAULT_TIMEOUT = 900

# `OperationProgressEvent` as `packages/types/src/ports/atlas/progress-event.port.ts` declares it.
# The SDK hands the event over unconverted, so the ETA field keeps its internal snake_case name.
PHASES = ("discovering", "processing", "finalizing", "completed", "interrupted")
TERMINAL_PHASES = {"completed", "interrupted"}
PROGRESS_FIELDS = {
    "operation",
    "workload",
    "phase",
    "processed",
    "total",
    "current",
    "rate",
    "eta_ms",
}

# `StorageRequestEvent` as `packages/types/src/ports/storage/storage-request-observer.port.ts`
# declares it in v7: required fields with their JSON types, then the optional ones.
STORAGE_REQUIRED: dict[str, tuple[type, ...]] = {
    "command": (str,),
    "workload": (str,),
    "keyClass": (str,),
    "startTime": (int, float),
    "durationMs": (int, float),
    "attempts": (int,),
    "retryDelayMs": (int, float),
}
STORAGE_OPTIONAL: dict[str, tuple[type, ...]] = {
    "operation": (str,),
    "socketWaitMs": (int, float),
    "networkMs": (int, float),
    "connectionReused": (bool,),
    "bytes": (int,),
    "statusCode": (int,),
    "errorType": (str,),
}
STORAGE_WORKLOADS = {
    "outlook",
    "onedrive",
    "sharepoint",
    "teams",
    "contacts",
    "calendar",
    "shared",
    "bucket",
}
STORAGE_KEY_CLASSES = {"data", "attachments", "manifests", "index", "staging", "_meta", "other"}


@dataclass(frozen=True)
class SdkRun:
    """One script run. `stdout` and `stderr` are scrubbed; `data` is the parsed document."""

    script: str
    code: int
    stdout: str
    stderr: str
    data: dict[str, Any] | None

    def describe(self) -> str:
        """Failure text for an assertion: the script, its exit code and its scrubbed output."""
        return f"node sdk/{self.script} -> exit {self.code}\n{self.stdout}\n{self.stderr}".strip()


def run(
    settings: Settings,
    script: str,
    env: Mapping[str, str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> SdkRun:
    """Runs `e2e/sdk/<script>` with the ATLAS_* variables plus `env`. Never raises on failure.

    Scenario inputs travel in the environment, never in argv, so no identifier or secret shows up
    in a process listing or in the log line below.
    """
    assert BUNDLE.exists(), f"SDK bundle not found at {BUNDLE}. Run `pnpm run build` first."
    log.info("node sdk/%s", script)
    # S603/S607: fixed argv, no shell, and `node` is resolved from PATH on purpose so the suite
    # runs against whatever Node the workflow selected.
    proc = subprocess.run(  # noqa: S603
        ["node", str(SCRIPT_DIR / script)],  # noqa: S607
        check=False,  # the caller inspects the exit code; a raise here would lose stdout
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=SCRIPT_DIR,
        env={"PATH": os.environ.get("PATH", ""), **settings.cli_env(), **(env or {})},
    )
    result = SdkRun(
        script=script,
        code=proc.returncode,
        stdout=scrub(proc.stdout, settings),
        stderr=scrub(proc.stderr, settings),
        data=_parse(proc.stdout),
    )
    log.info("node sdk/%s -> exit %d", script, result.code)
    return result


def ok(
    settings: Settings,
    script: str,
    env: Mapping[str, str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Runs a script, asserts a clean exit and one JSON object on stdout, and returns it."""
    result = run(settings, script, env, timeout)
    assert result.code == 0, result.describe()
    assert result.data is not None, f"no JSON document on stdout\n{result.describe()}"
    return result.data


def _parse(stdout: str) -> dict[str, Any] | None:
    """The script's document, or None when stdout is not one JSON object."""
    try:
        parsed: Any = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def progress_problems(events: list[dict[str, Any]], operation: str, workload: str) -> list[str]:
    """What is wrong with a progress stream, against the declared event type. Empty when valid.

    Every event names the operation and workload, carries only declared fields and a whole
    non-negative `processed`; phases never move backwards; exactly one terminal event comes last.
    """
    problems: list[str] = []
    if not events:
        return ["no progress event was emitted"]
    last_rank = 0
    for index, event in enumerate(events):
        extra = set(event.get("keys", [])) - PROGRESS_FIELDS
        if extra:
            problems.append(f"event {index} has undeclared fields {sorted(extra)}")
        if (event.get("operation"), event.get("workload")) != (operation, workload):
            problems.append(f"event {index} is not {operation}/{workload}")
        processed = event.get("processed")
        if not isinstance(processed, int) or isinstance(processed, bool) or processed < 0:
            problems.append(f"event {index} has no whole non-negative `processed`")
        phase = event.get("phase")
        if phase not in PHASES:
            problems.append(f"event {index} has unknown phase {phase!r}")
            continue
        rank = PHASES.index(phase)
        if rank < last_rank:
            problems.append(f"event {index} moves back to {phase}")
        last_rank = rank
    terminal = [e for e in events if e.get("phase") in TERMINAL_PHASES]
    if len(terminal) != 1 or events[-1].get("phase") not in TERMINAL_PHASES:
        problems.append("the stream does not end in exactly one terminal event")
    return problems


def phases(events: list[dict[str, Any]]) -> list[str]:
    """The phase of each event, in order."""
    return [str(event.get("phase")) for event in events]


def storage_event_problems(events: list[dict[str, Any]]) -> list[str]:
    """Events that do not match the declared `StorageRequestEvent` shape. Empty when all do."""
    problems: list[str] = []
    for index, event in enumerate(events):
        for name, types in STORAGE_REQUIRED.items():
            if not isinstance(event.get(name), types):
                problems.append(f"event {index}: `{name}` missing or mistyped")
        for name, types in STORAGE_OPTIONAL.items():
            if name in event and not isinstance(event[name], types):
                problems.append(f"event {index}: `{name}` mistyped")
        undeclared = set(event) - set(STORAGE_REQUIRED) - set(STORAGE_OPTIONAL)
        if undeclared:
            problems.append(f"event {index}: undeclared fields {sorted(undeclared)}")
        if event.get("workload") not in STORAGE_WORKLOADS:
            problems.append(f"event {index}: unknown workload")
        if event.get("keyClass") not in STORAGE_KEY_CLASSES:
            problems.append(f"event {index}: unknown keyClass")
    return problems


def leaked_values(text: str, values: Mapping[str, str]) -> list[str]:
    """Names of the values that occur in `text`. Short values would match by accident."""
    return sorted(
        name for name, value in values.items() if len(value) >= MIN_LITERAL_LENGTH and value in text
    )


def sole_owner(s3: Any, settings: Settings, workload: str) -> str:
    """The one mailbox, owner or site segment a workload suite backed up, read from the keys."""
    owners = storage.owner_segments(s3, settings.bucket, workload)
    assert len(owners) == 1, f"expected one {workload} owner, found {len(owners)}"
    return owners[0]


def snapshots_of(s3: Any, settings: Settings, owner: str, workload: str = "outlook") -> set[str]:
    """Snapshot ids of one owner, read from the manifest key names."""
    return set(storage.snapshot_ids(s3, settings.bucket, owner, workload))
