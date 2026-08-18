"""Turns `report.xml` into a Markdown table: `python -m atlas_e2e.summary >> $GITHUB_STEP_SUMMARY`.

A weekly job nobody opens is a job that fails silently, so the outcome has to be readable from the
run page without expanding a log. Stdlib only -- pytest already wrote the XML.
"""

from __future__ import annotations

import sys
from pathlib import Path
from xml.etree import ElementTree

REPORT = Path("report.xml")


def main() -> int:
    """Prints a per-test Markdown table plus a one-line total."""
    if not REPORT.exists():
        print("E2E did not produce a report: the run failed before pytest started.")
        return 0

    suites = ElementTree.parse(REPORT).getroot().iter("testsuite")
    rows: list[str] = []
    totals = {"passed": 0, "failed": 0, "skipped": 0}

    for suite in suites:
        for case in suite.iter("testcase"):
            outcome = _outcome(case)
            totals[outcome] += 1
            rows.append(f"| {_icon(outcome)} | `{case.get('classname', '')}` | {case.get('name', '')} |")

    print("## E2E result\n")
    print(f"**{totals['passed']} passed, {totals['failed']} failed, {totals['skipped']} skipped**\n")
    print("| | Suite | Test |")
    print("| - | ----- | ---- |")
    print("\n".join(rows))
    return 0


def _outcome(case: ElementTree.Element) -> str:
    """Classifies one testcase element."""
    if case.find("failure") is not None or case.find("error") is not None:
        return "failed"
    if case.find("skipped") is not None:
        return "skipped"
    return "passed"


def _icon(outcome: str) -> str:
    """Marker shown in the summary table."""
    return {"passed": "PASS", "failed": "FAIL", "skipped": "SKIP"}[outcome]


if __name__ == "__main__":
    sys.exit(main())
