"""One case per shipped bug, so a fix cannot quietly come back.

These are not unit tests moved outdoors. Each case is here because the bug only exists once real
infrastructure is involved: a bucket that gets provisioned, ciphertext that a real Node crypto
implementation must reject, an npm bundle that must import.

Bugs whose regression guard lives better elsewhere are named at the bottom of this file rather than
faked here.

Numbered 35 on purpose: after the workload suites, so their blobs exist to be tampered with, and
before `test_40_replication.py`, which purges primary and rehydrates only what it replicated.
"""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from typing import Any

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import REPO_ROOT, Settings

# A tenant id in valid GUID form that has certainly never been backed up.
UNKNOWN_TENANT = str(uuid.UUID(int=0xE2E))


def test_01_readonly_commands_provision_nothing(cli: Cli, s3: Any) -> None:
    """Read-only commands against an unknown tenant create no bucket and no DEK (issue #93).

    The original defect: `outlook list -t <unknown>` created the bucket and bootstrapped encryption
    key material. A typo, or a tenant belonging to another environment, silently provisioned
    infrastructure -- and in a bucket-per-tenant layout that is billable storage plus a key nobody
    tracks. `ListBuckets` before and after is the ground truth here; the CLI's own message is not.
    """
    before = {b["Name"] for b in s3.list_buckets()["Buckets"]}

    for argv in (
        ("outlook", "list", "-t", UNKNOWN_TENANT),
        ("stats", "-t", UNKNOWN_TENANT),
        ("list-users", "-t", UNKNOWN_TENANT),
    ):
        result = cli.run(*argv)
        after = {b["Name"] for b in s3.list_buckets()["Buckets"]}
        assert after == before, f"`atlas {' '.join(argv)}` provisioned: {sorted(after - before)}"
        # A read-only command against nothing must say so, not crash and not claim success.
        assert result.code in (0, 1), result.describe()


def test_02_corrupt_ciphertext_is_reported_as_tampering(
    cli: Cli, settings: Settings, s3: Any
) -> None:
    """A blob that fails its AES-GCM tag check is classified as authentication failure (issue #76).

    Issue #76 was the mirror of this: storage errors mentioning "auth" were reported as tampering.
    Fixing it required pinning the classifier to Node's exact tag-failure message -- and the fix
    suggested in the issue (`err.code === 'ERR_OSSL_BAD_DECRYPT'`) would have broken this direction
    entirely, because Node sets no `code` on that error. Only a real decrypt against real ciphertext
    proves which of those two is true, which is why this case lives out here.

    The negative direction (a storage authorization error must *not* be reported as tampering) stays
    a unit test: producing a genuine per-prefix S3 denial needs a scoped MinIO user that only exists
    to be denied, and a fabricated credential failure is exactly what a mock is for.
    """
    owners = {k.split("/")[2] for k in storage.list_keys(s3, settings.bucket, "onedrive/manifests/")}
    assert len(owners) == 1, f"expected one backed-up OneDrive owner, found {sorted(owners)}"
    owner = owners.pop()
    snapshots = storage.snapshot_ids(s3, settings.bucket, owner, "onedrive")
    assert snapshots, "no OneDrive snapshot to restore"

    blobs = storage.list_keys(s3, settings.bucket, "onedrive/data/")
    assert blobs, "no OneDrive blob to corrupt; the OneDrive suite must have run first"

    # Flip one bit inside every blob's ciphertext body, past the [IV][tag] envelope header, so each
    # blob stays structurally valid and fails at the tag check rather than at parsing. Corrupting
    # all of them removes the question of which blob the chosen snapshot references.
    originals = {key: s3.get_object(Bucket=settings.bucket, Key=key)["Body"].read() for key in blobs}
    for key, original in originals.items():
        corrupted = bytearray(original)
        corrupted[-1] ^= 0x01
        s3.put_object(Bucket=settings.bucket, Key=key, Body=bytes(corrupted))

    try:
        result = cli.run(
            "onedrive",
            "restore",
            "-o",
            settings.onedrive_owner,
            "-s",
            snapshots[0],
            "--conflict",
            "rename",
        )
        assert result.code != 0, f"restore of tampered ciphertext reported success\n{result.describe()}"
        lower = result.out.lower()
        assert "authentication failed" in lower, result.describe()
        # The distinction that matters to an operator: this must not read as a transient or
        # missing-object problem, because the honest diagnosis is wrong key or altered bytes.
        assert "missing or unreadable" not in lower, result.describe()
    finally:
        for key, original in originals.items():
            s3.put_object(Bucket=settings.bucket, Key=key, Body=original)


def test_03_sdk_lists_the_snapshots_the_cli_wrote(settings: Settings, s3: Any) -> None:
    """The published SDK bundle sees exactly the snapshots in the bucket.

    The CLI and the SDK are separately published artifacts over one core. This imports
    `packages/sdk/dist/index.mjs` -- the file that goes to npm -- so a bundle that cannot resolve its
    own dependencies fails here rather than in an integrator's issue.
    """
    owner = _sole_owner(s3, settings)
    expected = set(storage.snapshot_ids(s3, settings.bucket, owner))
    assert expected, "no Outlook snapshot in the bucket for the SDK to read"

    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", str(REPO_ROOT / "e2e" / "sdk_smoke.mjs")],
        capture_output=True,
        text=True,
        timeout=300,
        env={
            "PATH": os.environ.get("PATH", ""),
            "E2E_MAILBOX": settings.mailbox,
            **settings.cli_env(),
        },
    )
    assert proc.returncode == 0, f"sdk_smoke.mjs -> exit {proc.returncode}\n{proc.stderr.strip()}"
    assert set(json.loads(proc.stdout)) == expected, (
        f"SDK reported {len(json.loads(proc.stdout))} snapshot(s), bucket holds {len(expected)}"
    )


def _sole_owner(s3: Any, settings: Settings) -> str:
    """The one Outlook owner segment in the bucket, read from the manifest keys."""
    owners = {key.split("/")[1] for key in storage.list_keys(s3, settings.bucket, "manifests/")}
    assert len(owners) == 1, f"expected exactly one backed-up owner, found {sorted(owners)}"
    return owners.pop()


# Covered elsewhere, deliberately not duplicated here:
#
# * #90 (SharePoint site URLs reaching the storage key builder) -- `test_30_sharepoint.py` addresses
#   the same library by browser URL, `hostname/sites/name` short form, and composite
#   `hostname,siteGuid,webGuid` id, and asserts all three resolve to one stored tree. Asserting "no
#   Graph resolve call was issued" would need request interception the suite has no other use for.
# * #110 (SharePoint version-content 400) -- any first backup of a freshly uploaded file exercises
#   it; `test_30_sharepoint.py` requires a clean exit, which is what regressed.
