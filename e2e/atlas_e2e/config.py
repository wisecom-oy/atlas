"""Environment to typed settings. Fails fast, naming the variable that is missing."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Secrets: supplied by the `e2e` GitHub environment. No defaults -- a missing one is an error.
_SECRETS = ("E2E_TENANT_ID", "E2E_CLIENT_ID", "E2E_CLIENT_SECRET", "E2E_ENCRYPTION_PASSPHRASE", "E2E_MAILBOX")

# MinIO runs in the runner and is thrown away with it, so its credentials are not secrets.
_DEFAULTS = {
    "E2E_S3_ENDPOINT": "http://127.0.0.1:9000",
    "E2E_S3_REPLICA_ENDPOINT": "http://127.0.0.1:9002",
    "E2E_S3_ACCESS_KEY": "minioadmin",
    "E2E_S3_SECRET_KEY": "minioadmin",
    "E2E_S3_REGION": "us-east-1",
    "E2E_CLI": str(REPO_ROOT / "packages" / "cli" / "dist" / "cli.mjs"),
}


@dataclass(frozen=True)
class Settings:
    """Everything the suite needs to talk to Graph, S3, and the CLI.

    Secret and tenant-identifying fields are `repr=False`: pytest prints the repr of every fixture
    argument in a failing test's traceback, and that traceback is written verbatim into
    `report.xml`, which is uploaded as a public artifact. GitHub masks secrets in *logs*, never in
    a file. Non-identifying fields stay visible so a failure header still says how the run was
    configured.
    """

    tenant_id: str = field(repr=False)
    client_id: str = field(repr=False)
    client_secret: str = field(repr=False)
    passphrase: str = field(repr=False)
    mailbox: str = field(repr=False)
    s3_endpoint: str
    s3_replica_endpoint: str
    s3_access_key: str = field(repr=False)
    s3_secret_key: str = field(repr=False)
    s3_region: str
    cli: Path
    onedrive_owner: str = field(repr=False)
    sharepoint_site: str = field(repr=False)

    @property
    def bucket(self) -> str:
        """Atlas derives the bucket from the tenant id; the suite must not guess a different name."""
        return f"atlas-{self.tenant_id}"

    @property
    def configured_workloads(self) -> list[str]:
        """Workloads this run actually backs up, in storage-prefix terms.

        A workload whose identifier is unset is skipped by its own suite, so no later suite may
        demand its objects. Shared so replication, per-workload deletion and the tenant purge all
        assert against the same set instead of each hardcoding one prefix (issue #210).
        """
        workloads = ["outlook"]
        if self.onedrive_owner:
            workloads.append("onedrive")
        if self.sharepoint_site:
            workloads.append("sharepoint")
        return workloads

    def cli_env(self) -> dict[str, str]:
        """ATLAS_* variables for a CLI subprocess. Env wins over the secure store, so no config file is needed."""
        return {
            "ATLAS_TENANT_ID": self.tenant_id,
            "ATLAS_CLIENT_ID": self.client_id,
            "ATLAS_CLIENT_SECRET": self.client_secret,
            "ATLAS_ENCRYPTION_PASSPHRASE": self.passphrase,
            "ATLAS_S3_ENDPOINT": self.s3_endpoint,
            "ATLAS_S3_ACCESS_KEY": self.s3_access_key,
            "ATLAS_S3_SECRET_KEY": self.s3_secret_key,
            "ATLAS_S3_REGION": self.s3_region,
        }


def load() -> Settings:
    """Reads the environment into Settings, raising on the first missing secret."""
    missing = [name for name in _SECRETS if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            f"Missing required environment variable(s): {', '.join(missing)}. "
            "See e2e/README.md; in CI these come from the `e2e` GitHub environment."
        )

    def value(name: str) -> str:
        return os.environ.get(name) or _DEFAULTS[name]

    cli = Path(value("E2E_CLI"))
    if not cli.exists():
        raise RuntimeError(f"CLI bundle not found at {cli}. Run `pnpm run build` first.")

    return Settings(
        tenant_id=os.environ["E2E_TENANT_ID"],
        client_id=os.environ["E2E_CLIENT_ID"],
        client_secret=os.environ["E2E_CLIENT_SECRET"],
        passphrase=os.environ["E2E_ENCRYPTION_PASSPHRASE"],
        mailbox=os.environ["E2E_MAILBOX"],
        s3_endpoint=value("E2E_S3_ENDPOINT"),
        s3_replica_endpoint=value("E2E_S3_REPLICA_ENDPOINT"),
        s3_access_key=value("E2E_S3_ACCESS_KEY"),
        s3_secret_key=value("E2E_S3_SECRET_KEY"),
        s3_region=value("E2E_S3_REGION"),
        cli=cli,
        # Phase 2 workloads: absent until their fixtures exist, so the Outlook suite can run alone.
        onedrive_owner=os.environ.get("E2E_ONEDRIVE_OWNER", ""),
        sharepoint_site=os.environ.get("E2E_SHAREPOINT_SITE", ""),
    )

