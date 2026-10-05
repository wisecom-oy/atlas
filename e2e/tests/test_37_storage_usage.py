"""`stats storage` reports what the bucket physically holds (issue #468).

Numbered 37: after the workload suites and the regressions, so the bucket holds every workload's
blobs, manifests, retained versions and delete markers, and before `test_40_replication.py`, which
purges primary. The S3 version and multipart listings are the ground truth; the CLI is compared
against them, never against itself.
"""

from __future__ import annotations

import json
from typing import Any

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

CATEGORIES = ("current", "noncurrent", "delete_markers", "incomplete_uploads")


def _usage(cli: Cli, *args: str) -> dict[str, Any]:
    result = cli.ok("stats", "storage", "--json", *args)
    report: dict[str, Any] = json.loads(result.stdout)
    return report


def test_01_totals_match_the_bucket_listing(cli: Cli, settings: Settings, s3: Any) -> None:
    """Every category equals S3's own listing, and the workload rows sum to the totals."""
    report = _usage(cli)
    truth = storage.physical_usage(s3, settings.bucket)

    assert report["complete"] is True
    assert report["versions_visible"] is True
    for category in CATEGORIES:
        assert report["totals"][category] == truth[category], category
    for field in ("current", "noncurrent", "incomplete_uploads"):
        rows = report["by_workload"].values()
        assert sum(row[field]["bytes"] for row in rows) == report["totals"][field]["bytes"], field
    assert set(report["by_workload"]) >= set(settings.configured_workloads)


def test_02_logical_bytes_are_reported_after_backups(cli: Cli) -> None:
    """The bucket holds manifests by now, so the logical side of the dedup ratio is present."""
    report = _usage(cli)

    assert report["logical_bytes_referenced"] > 0
    assert report["logical_bytes_referenced"] == sum(report["logical_bytes_by_workload"].values())


def test_03_a_sliced_run_resumes_to_the_same_report(cli: Cli) -> None:
    """One request per call, resumed through the token, ends with the one-shot numbers."""
    one_shot = _usage(cli)
    report: dict[str, Any] = {}
    for _ in range(500):
        token = report.get("continuation_token")
        report = _usage(cli, "--max-requests", "1", *(("--continue", token) if token else ()))
        if report["complete"]:
            break

    assert report["complete"] is True
    assert report["totals"] == one_shot["totals"]
    assert report["by_workload"] == one_shot["by_workload"]
