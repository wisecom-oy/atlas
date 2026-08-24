"""Proves the redaction boundary holds, before the suite is allowed near a real tenant.

Everything this suite publishes is a public artifact of a public repository, so redaction is not a
nicety. These checks run first in CI: if any of them fails the job stops before a single Graph call,
rather than discovering the hole in an uploaded file (issues #174, #175).

Run with `uv run python -m atlas_e2e.self_check`.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from atlas_e2e.atlas import Cli, Result
from atlas_e2e.config import Settings
from atlas_e2e.scrub import scrub

# Recognisable stand-ins, none of them a real value. Each is long enough to pass the eight-character
# floor in `scrub._literals`.
_FAKE = Settings(
    tenant_id="tenant-11111111",
    client_id="client-22222222",
    client_secret="secret-33333333",
    passphrase="passphrase-44444444",
    mailbox="john.doe@example.com",
    s3_endpoint="http://127.0.0.1:9000",
    s3_replica_endpoint="http://127.0.0.1:9002",
    s3_access_key="access-55555555",
    s3_secret_key="secretkey-66666666",
    s3_region="us-east-1",
    cli=Path("/nonexistent/cli.mjs"),
    onedrive_owner="jane.roe@example.com",
    sharepoint_site="contoso.sharepoint.com,00000000-0000-0000-0000-000000000000",
)

_SECRET_VALUES = (
    _FAKE.tenant_id,
    _FAKE.client_id,
    _FAKE.client_secret,
    _FAKE.passphrase,
    _FAKE.mailbox,
    _FAKE.onedrive_owner,
    _FAKE.sharepoint_site,
    _FAKE.s3_access_key,
    _FAKE.s3_secret_key,
)


def check_settings_repr_hides_secrets() -> None:
    """pytest prints fixture reprs into `report.xml`; none of them may carry a secret (#174)."""
    rendered = repr(_FAKE)
    leaked = [value for value in _SECRET_VALUES if value in rendered]
    assert not leaked, f"Settings repr exposes {len(leaked)} secret field(s)"
    assert "s3_region" in rendered, "the repr lost every field; failure headers say nothing now"


def check_scrub_redacts_every_secret() -> None:
    """Each configured value, and the shapes derived from it, must not survive `scrub`."""
    text = " ".join(_SECRET_VALUES) + " https://contoso.sharepoint.com/sites/Example"
    cleaned = scrub(text, _FAKE)
    leaked = [value for value in _SECRET_VALUES if value in cleaned]
    assert not leaked, f"scrub left {len(leaked)} secret value(s) intact"
    assert "sharepoint.com" not in cleaned, "scrub left a tenant hostname intact"


def check_result_streams_are_scrubbed() -> None:
    """`Cli.run` must redact both streams, so no consumer can reach raw CLI output (#175)."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        stub = root / "stub.mjs"
        stub.write_text(
            "process.stdout.write(process.env.ATLAS_TENANT_ID + ' out\\n');\n"
            "process.stderr.write(process.env.ATLAS_CLIENT_SECRET + ' err\\n');\n",
            encoding="utf-8",
        )
        transcript = root / "logs" / "cli.log"
        settings = Settings(**{**_FAKE.__dict__, "cli": stub})
        cli = Cli(settings, root / "home", transcript)

        result = cli.run("anything")

        assert _FAKE.tenant_id not in result.out, "stdout reached the caller unscrubbed"
        assert _FAKE.client_secret not in result.out, "stderr reached the caller unscrubbed"
        assert _FAKE.tenant_id not in result.describe(), "describe() exposed stdout"
        assert _FAKE.client_secret not in result.describe(), "describe() exposed stderr"

        written = transcript.read_text(encoding="utf-8")
        assert "anything" in written, "the transcript lost the command it recorded"
        assert "[exit 0]" in written, "the transcript lost the exit code"
        assert " out" not in written, "the transcript recorded CLI stdout"
        assert " err" not in written, "the transcript recorded CLI stderr"


def check_transcript_never_holds_output() -> None:
    """Even a hand-built Result must not put CLI output in the transcript."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        transcript = root / "logs" / "cli.log"
        cli = Cli(_FAKE, root / "home", transcript)
        noisy = Result(argv=("status",), code=2, stdout="Report.docx stored", stderr="John Doe")

        cli._record(noisy)  # noqa: SLF001 - the guarantee under test is internal

        written = transcript.read_text(encoding="utf-8")
        assert "Report.docx" not in written, "a file name reached the transcript"
        assert "John Doe" not in written, "a display name reached the transcript"
        assert "[exit 2]" in written, "the transcript lost the exit code"


CHECKS = (
    check_settings_repr_hides_secrets,
    check_scrub_redacts_every_secret,
    check_result_streams_are_scrubbed,
    check_transcript_never_holds_output,
)


def main() -> None:
    """Runs every check, reporting the first failure by name."""
    for check in CHECKS:
        check()
        print(f"ok  {check.__name__}")
    print(f"{len(CHECKS)} redaction check(s) passed.")


if __name__ == "__main__":
    main()
