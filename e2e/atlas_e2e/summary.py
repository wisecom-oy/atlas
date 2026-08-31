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
    """Prints a per-suite Markdown table, the failing test names, and a one-line total."""
    if not REPORT.exists():
        print("E2E did not produce a report: the run failed before pytest started.")
        return 0

    # S314: report.xml is produced by this suite's own pytest run, not untrusted input.
    root = ElementTree.parse(REPORT).getroot()  # noqa: S314
    per_suite: dict[str, dict[str, int]] = {}
    failures: list[str] = []

    for case in root.iter("testcase"):
        suite = _suite_name(case)
        counts = per_suite.setdefault(suite, {"passed": 0, "failed": 0, "skipped": 0})
        outcome = _outcome(case)
        counts[outcome] += 1
        if outcome == "failed":
            failures.append(f"`{suite}` -- {case.get('name', '')}")

    totals = {
        key: sum(counts[key] for counts in per_suite.values())
        for key in ("passed", "failed", "skipped")
    }

    print("## E2E result\n")
    print(
        f"**{totals['passed']} passed, {totals['failed']} failed, {totals['skipped']} skipped**\n"
    )
    print("| | Suite | Passed | Failed | Skipped |")
    print("| - | ----- | ------ | ------ | ------- |")
    for suite, counts in sorted(per_suite.items()):
        # A suite that ran nothing must not read as green: absent coverage is not a pass.
        verdict = "FAIL" if counts["failed"] else "PASS" if counts["passed"] else "SKIP"
        print(
            f"| {verdict} | {suite} | {counts['passed']} "
            f"| {counts['failed']} | {counts['skipped']} |"
        )

    # The table answers "is it broken"; these lines answer "where", without needing the log.
    if failures:
        print("\n### Failed\n")
        for failure in failures:
            print(f"- {failure}")
    return 0


def _suite_name(case: ElementTree.Element) -> str:
    """The suite a testcase belongs to, e.g. `test_10_outlook`."""
    classname = case.get("classname", "")
    return classname.split(".")[-1] or "unknown"
    return 0


def _outcome(case: ElementTree.Element) -> str:
    """Classifies one testcase element."""
    if case.find("failure") is not None or case.find("error") is not None:
        return "failed"
    if case.find("skipped") is not None:
        return "skipped"
    return "passed"


if __name__ == "__main__":
    sys.exit(main())
