"""Runs the shipped CLI bundle as a subprocess, so the suite tests the artifact we release."""

from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from atlas_e2e.config import Settings
from atlas_e2e.scrub import scrub

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 900

# `onedrive backup` has no folder scope: it syncs the owner's entire drive, and the suite recreates
# the MinIO volumes every run, so every run pays a full initial crawl of whatever that drive holds.
# Backup, verify, save and restore therefore scale with the tenant's real content rather than with
# the fixtures, and 900s was not enough for a drive with many items (issue #211).
#
# ponytail: a flat 30 minutes per whole-drive call, not a size-derived budget. The ceiling is the
# 60-minute job timeout in e2e.yml, so this cannot grow much further. The real fixes are a folder or
# filter scope on `onedrive backup`, or a test account whose drive holds only the
# fixtures; until one of those exists, a drive that outgrows this will fail here
# with a clear timeout rather than silently
# eating the whole job budget.
WHOLE_DRIVE_TIMEOUT = 1800

# Ink wraps to `process.stdout.columns` and falls back to 80 without a TTY. The CLI honours
# `COLUMNS` when its output is piped, so this width keeps every cell on one line.
NO_WRAP_COLUMNS = 4096


@dataclass(frozen=True)
class Result:
    """One CLI invocation: what was asked, what came back.

    Every field is already scrubbed. `run` redacts both streams before constructing this, so no
    consumer can reach raw CLI output: not an assertion message, not the transcript, not a future
    code path someone adds without reading this module.
    """

    argv: tuple[str, ...]
    code: int
    stdout: str
    stderr: str

    @property
    def out(self) -> str:
        """Both streams. Atlas writes dashboards to stdout and per-item errors to stderr."""
        return f"{self.stdout}\n{self.stderr}"

    def describe(self) -> str:
        """Failure text for an assertion: the command and its output, never the environment."""
        return f"atlas {' '.join(self.argv)} -> exit {self.code}\n{self.out.strip()}"


class Cli:
    """A CLI bound to one settings object and one isolated HOME."""

    def __init__(self, settings: Settings, home: Path, transcript: Path | None = None) -> None:
        self._settings = settings
        # An isolated HOME keeps ~/.atlas/config.enc and the OS keyring out of the run: the suite
        # must depend on the env vars it sets, not on whatever a developer configured locally.
        self._home = home
        home.mkdir(parents=True, exist_ok=True)
        # Commands and exit codes only, never CLI output: see `_record`.
        self._transcript = transcript
        if transcript:
            transcript.parent.mkdir(parents=True, exist_ok=True)

    def run(self, *args: str, timeout: int = DEFAULT_TIMEOUT) -> Result:
        """Invokes `atlas <args>` and captures both streams. Never raises on a non-zero exit.

        The stored argv is scrubbed: it can carry the site URL or composite ids (SharePoint
        `--site`), and both the log line below and failure descriptions end up in public CI logs.
        """
        argv = tuple(str(a) for a in args)
        display_argv = tuple(scrub(arg, self._settings) for arg in argv)
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self._home),
            # Non-TTY output: Ink renders a static view, which is what we want in CI logs.
            "CI": "1",
            "NO_COLOR": "1",
            # Without a TTY Ink lays out at 80 columns and wraps long cells mid-value. Every rule in
            # `scrub` needs the value contiguous, so a wrapped address or site URL survives
            # redaction. A width nothing reaches keeps values on one line.
            "COLUMNS": str(NO_WRAP_COLUMNS),
            **self._settings.cli_env(),
        }
        log.info("atlas %s", " ".join(display_argv))
        # S603/S607: fixed argv, no shell, and `node` is resolved from PATH on purpose so the
        # suite runs against whatever Node the workflow selected.
        proc = subprocess.run(  # noqa: S603
            ["node", str(self._settings.cli), *argv],  # noqa: S607
            check=False,  # the caller inspects returncode; a raise here would lose stdout
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=self._home,  # no repo-root atlas.config.json in scope
            env=env,
        )
        result = Result(
            argv=display_argv,
            code=proc.returncode,
            stdout=scrub(proc.stdout, self._settings),
            stderr=scrub(proc.stderr, self._settings),
        )
        self._record(result)
        return result

    def _record(self, result: Result) -> None:
        """Appends one invocation to the transcript: the command and its exit code, no output.

        The transcript is a public artifact and the CLI prints live tenant content -- owner display
        names, document names, the tenant's site inventory. None of that is a secret value or a
        recognisable shape, so no redaction rule can catch it, and pattern matching is the wrong
        tool for "everything except our own fixtures". So the output is simply never written.
        Assertions still carry the scrubbed output through `describe`.
        """
        if not self._transcript:
            return
        entry = f"$ atlas {' '.join(result.argv)}\n[exit {result.code}]\n\n"
        with self._transcript.open("a", encoding="utf-8") as handle:
            handle.write(scrub(entry, self._settings))

    def ok(self, *args: str, timeout: int = DEFAULT_TIMEOUT) -> Result:
        """Runs and asserts a clean exit.

        Exit 2 (partial) is a failure: the suite seeded every item.
        """
        result = self.run(*args, timeout=timeout)
        assert result.code == 0, result.describe()
        return result
