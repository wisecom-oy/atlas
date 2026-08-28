"""Proves the redaction boundary holds, before the suite is allowed near a real tenant.

Everything this suite publishes is a public artifact of a public repository, so redaction is not a
nicety. These checks run first in CI: if any of them fails the job stops before a single Graph call,
rather than discovering the hole in an uploaded file (issues #174, #175).

Run with `uv run python -m atlas_e2e.self_check`.
"""

from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from atlas_e2e import cleanup, drive
from atlas_e2e.atlas import Cli, Result
from atlas_e2e.marker import PREFIX
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


class _FakeGraph:
    """Serves one page of children per path and records deletes. No transport, no tenant."""

    def __init__(self, children_by_path: dict[str, list[dict[str, object]]]) -> None:
        self._children_by_path = children_by_path
        self.deleted: list[str] = []

    def paged(self, url: str, **_params: object) -> list[dict[str, object]]:
        return self._children_by_path.get(url, [])

    def delete(self, url: str) -> None:
        self.deleted.append(url.rsplit("/", 1)[-1])


def _drive_item(name: str, item_id: str, age_hours: float = 0.0) -> dict[str, object]:
    created = datetime.now(timezone.utc) - timedelta(hours=age_hours)
    return {"id": item_id, "name": name, "createdDateTime": created.isoformat()}


def _fake_drive(fixture_root: list[dict[str, object]], root: list[dict[str, object]]) -> _FakeGraph:
    return _FakeGraph(
        {
            f"/drives/d1/root:/{drive.FIXTURE_ROOT}:/children": fixture_root,
            "/drives/d1/root/children": root,
        }
    )


_REAL_FILES = ("Contract.docx", "recovery-codes.txt", "Holiday.mp4")


def check_cleanup_never_deletes_unmarked_items() -> None:
    """The destructive boundary: cleanup may only delete what the suite named.

    An earlier `sweep_drive` treated any unmarked item under the fixture root as debris, on the
    theory that the folder was suite-owned. It deleted a tenant's real files. This runs before the
    suite is allowed near a tenant, for the same reason the redaction checks do.

    Discovery is stubbed out on purpose. `fixture_items` also filters by marker, and asserting
    through it would let this pass while the deletion rule itself was unsafe. Each layer is checked
    where it decides, so removing either one fails a check.
    """
    # Aged deliberately. For an unmarked item the staleness rule inverts: "old enough that no live
    # run can own it" reads as permission to delete, so a real file became *more* deletable the
    # longer it had existed. That is how the incident happened, and a fresh fixture would not
    # reproduce it.
    real = [_drive_item(name, f"id-{i}", age_hours=48) for i, name in enumerate(_REAL_FILES)]
    graph = _fake_drive(fixture_root=[], root=[])
    original = drive.fixture_items
    drive.fixture_items = lambda *_args, **_kwargs: real  # type: ignore[assignment]
    try:
        removed = cleanup.sweep_drive(graph, "d1", f"{PREFIX}-run-1")  # type: ignore[arg-type]
    finally:
        drive.fixture_items = original  # type: ignore[assignment]

    assert removed == [], f"cleanup deleted unmarked items: {removed}"
    assert graph.deleted == [], f"cleanup issued deletes for unmarked items: {graph.deleted}"


def check_fixture_discovery_only_returns_marked() -> None:
    """Second layer: discovery must not hand cleanup anything unmarked in the first place."""
    real = [_drive_item(name, f"id-{i}") for i, name in enumerate(_REAL_FILES)]
    marked = _drive_item(f"{PREFIX}-run-1", "id-run")
    graph = _fake_drive(fixture_root=[*real, marked], root=real)

    found = drive.fixture_items(graph, "d1", PREFIX)  # type: ignore[arg-type]

    assert [i["name"] for i in found] == [f"{PREFIX}-run-1"], f"discovery returned real files: {found}"


def check_cleanup_still_removes_this_run() -> None:
    """The other half: a guard that deletes nothing would pass the check above."""
    this_run = f"{PREFIX}-run-1"
    graph = _fake_drive(fixture_root=[_drive_item(this_run, "id-run")], root=[])

    assert cleanup.sweep_drive(graph, "d1", this_run) == [this_run]  # type: ignore[arg-type]
    assert graph.deleted == ["id-run"]


def check_cleanup_spares_a_concurrent_run() -> None:
    """A foreign marker is left until stale, so a live run is never swept from under."""
    graph = _fake_drive(fixture_root=[_drive_item(f"{PREFIX}-run-2", "id-foreign")], root=[])

    assert cleanup.sweep_drive(graph, "d1", f"{PREFIX}-run-1") == []  # type: ignore[arg-type]

    stale = _fake_drive(
        fixture_root=[_drive_item(f"{PREFIX}-run-2", "id-stale", age_hours=48)], root=[]
    )
    assert stale.deleted == []
    assert cleanup.sweep_drive(stale, "d1", f"{PREFIX}-run-1") == [f"{PREFIX}-run-2"]  # type: ignore[arg-type]


CHECKS = (
    check_settings_repr_hides_secrets,
    check_scrub_redacts_every_secret,
    check_result_streams_are_scrubbed,
    check_transcript_never_holds_output,
    check_cleanup_never_deletes_unmarked_items,
    check_fixture_discovery_only_returns_marked,
    check_cleanup_still_removes_this_run,
    check_cleanup_spares_a_concurrent_run,
)


def main() -> None:
    """Runs every check, reporting the first failure by name."""
    for check in CHECKS:
        check()
        print(f"ok  {check.__name__}")
    print(f"{len(CHECKS)} safety check(s) passed.")


if __name__ == "__main__":
    main()
