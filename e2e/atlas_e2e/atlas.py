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


@dataclass(frozen=True)
class Result:
    """One CLI invocation: what was asked, what came back."""

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
        # Uploaded as an artifact, so it is written scrubbed rather than scrubbed later: a file that
        # was never allowed to hold a secret cannot leak one through a forgotten code path.
        self._transcript = transcript
        if transcript:
            transcript.parent.mkdir(parents=True, exist_ok=True)

    def run(self, *args: str, timeout: int = DEFAULT_TIMEOUT) -> Result:
        """Invokes `atlas <args>` and captures both streams. Never raises on a non-zero exit."""
        argv = tuple(str(a) for a in args)
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self._home),
            # Non-TTY output: Ink renders a static view, which is what we want in CI logs.
            "CI": "1",
            "NO_COLOR": "1",
            **self._settings.cli_env(),
        }
        log.info("atlas %s", " ".join(argv))
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["node", str(self._settings.cli), *argv],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=self._home,  # no repo-root atlas.config.json in scope
            env=env,
        )
        result = Result(argv=argv, code=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)
        self._record(result)
        return result

    def _record(self, result: Result) -> None:
        """Appends one scrubbed invocation to the transcript, when one is configured."""
        if not self._transcript:
            return
        entry = f"$ atlas {' '.join(result.argv)}\n{result.out.strip()}\n[exit {result.code}]\n\n"
        with self._transcript.open("a", encoding="utf-8") as handle:
            handle.write(scrub(entry, self._settings))

    def ok(self, *args: str, timeout: int = DEFAULT_TIMEOUT) -> Result:
        """Runs and asserts a clean exit. Exit 2 (partial) is a failure here: E2E fixtures are tiny."""
        result = self.run(*args, timeout=timeout)
        assert result.code == 0, result.describe()
        return result
