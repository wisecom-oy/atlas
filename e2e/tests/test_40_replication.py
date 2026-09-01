"""Disaster recovery: replicate to a second endpoint, destroy primary, rehydrate, verify.

This is the suite that matters most and is hardest to rehearse by hand. It deliberately destroys the
primary bucket mid-flight, because a DR drill that keeps its safety net proves nothing.

The replica must be a different *endpoint*, not a second bucket: Atlas derives the bucket name from
the tenant id, so both sides carry the same name.
"""

from __future__ import annotations

from typing import Any

from atlas_e2e import storage
from atlas_e2e.atlas import Cli
from atlas_e2e.config import Settings

STATE: dict[str, Any] = {}


def test_01_replica_endpoint_is_reachable(settings: Settings, s3_replica: Any) -> None:
    """The second MinIO answers, and starts without the tenant bucket."""
    assert storage.bucket_names(s3_replica) is not None
    assert not storage.bucket_exists(s3_replica, settings.bucket), (
        "the replica already holds the tenant bucket; the compose volumes were not recreated"
    )


def test_02_replicate_copies_every_workload_and_the_key(
    cli: Cli, settings: Settings, s3: Any, s3_replica: Any
) -> None:
    """Replication copies manifests, blobs and the wrapped DEK for every configured workload.

    The DEK matters more than the data: without `_meta/dek.enc` the replica is a pile of ciphertext
    nobody can open, so a "successful" replication that omitted it would be worthless.

    Every workload is replicated explicitly because `replicate` has no tenant-wide scope: its
    selectors are `-s`, `-m`, `--site` and `-o`. Replicating only the mailbox left the drives out of
    the replica, and since `test_04` purges the whole bucket, `test_05` could not bring them back.
    That is what silently emptied the drive prefixes before `test_85` asserted on them (issue #210).
    """
    primary_keys = storage.list_keys(s3, settings.bucket)
    assert primary_keys, "nothing on primary to replicate; earlier suites stored no objects"
    STATE["snapshot"] = storage.snapshot_ids(s3, settings.bucket, _owner(s3, settings.bucket))[0]

    _replicate(cli, settings, "-m", settings.mailbox)
    if settings.onedrive_owner:
        _replicate(cli, settings, "-o", settings.onedrive_owner)
    if settings.sharepoint_site:
        _replicate(cli, settings, "--site", settings.sharepoint_site)

    replica_keys = storage.list_keys(s3_replica, settings.bucket)
    assert "_meta/dek.enc" in replica_keys, "the wrapped DEK was not replicated"

    # Ciphertext is copied as-is, so the replicated keys must be byte-identical addresses. Asserted
    # per workload and per prefix: one bucket-wide subset check passes while a whole workload, or a
    # workload's blobs, are missing.
    for workload in settings.configured_workloads:
        for prefix in (storage.MANIFEST_PREFIXES[workload], storage.DATA_PREFIXES[workload]):
            primary = {k for k in primary_keys if k.startswith(prefix)}
            replica = {k for k in replica_keys if k.startswith(prefix)}
            assert primary, f"{workload} stored nothing under {prefix}; its suite did not run"
            assert primary <= replica, (
                f"{workload} objects missing from the replica under {prefix}: "
                f"{sorted(primary - replica)[:5]}"
            )

    # Attachments are only their own objects in pre-MIME snapshots (issue #138), so this asserts
    # they replicate when present rather than requiring them.
    attachments = {k for k in primary_keys if k.startswith("attachments/")}
    assert attachments <= {k for k in replica_keys if k.startswith("attachments/")}, (
        "attachment objects did not reach the replica"
    )


def test_03_status_records_the_replication(cli: Cli, settings: Settings, s3: Any) -> None:
    """`replicate --status` reads the sidecar records replication wrote on primary."""
    cli.ok("replicate", "--status", "-m", settings.mailbox)
    assert storage.list_keys(s3, settings.bucket, "_meta/replication/"), (
        "no replication record written"
    )


def test_04_primary_is_destroyed(cli: Cli, settings: Settings, s3: Any) -> None:
    """Wipes primary, including the DEK. Without this the rehydrate below proves nothing."""
    cli.ok("delete", "--purge", "-y")
    assert storage.list_keys(s3, settings.bucket) == [], "primary still holds objects after purge"


def test_05_rehydrate_recovers_from_the_replica(
    cli: Cli, settings: Settings, s3: Any, s3_replica: Any
) -> None:
    """Recovers every workload from the replica into the emptied primary bucket.

    `--all` rather than `-m`: a drill that recovers one workload while reporting success for the
    tenant is the failure mode this asserts against. The per-workload check below is what makes that
    real. Comparing only the Outlook `manifests/` prefix passed while both drives were absent, which
    is how the gap behind issue #210 stayed invisible here.
    """
    cli.ok(
        "rehydrate",
        "--all",
        "--source-endpoint",
        settings.s3_replica_endpoint,
        "--source-access-key",
        settings.s3_access_key,
        "--source-secret-key",
        settings.s3_secret_key,
    )

    recovered = set(storage.list_keys(s3, settings.bucket))
    assert "_meta/dek.enc" in recovered, "the DEK was not copied back; the data cannot be decrypted"

    replica_keys = storage.list_keys(s3_replica, settings.bucket)
    for workload in settings.configured_workloads:
        prefix = storage.MANIFEST_PREFIXES[workload]
        replicated = {k for k in replica_keys if k.startswith(prefix)}
        assert replicated, f"{workload} has no manifest on the replica to recover"
        assert replicated <= recovered, (
            f"{workload} manifests did not come back: {sorted(replicated - recovered)[:5]}"
        )


def test_06_verify_passes_on_rehydrated_data(cli: Cli, settings: Settings) -> None:
    """The recovered snapshot decrypts and hashes correctly under the copied key.

    This is the assertion that makes the whole DR loop meaningful: `verify` downloads every object,
    decrypts it with the DEK that came from the replica, and compares SHA-256 against the manifest.
    """
    cli.ok("outlook", "verify", "-m", settings.mailbox, "-s", STATE["snapshot"])


def _owner(s3: Any, bucket: str) -> str:
    """The Outlook owner segment Atlas used, read from the manifest keys."""
    owners = {key.split("/")[1] for key in storage.list_keys(s3, bucket, "manifests/")}
    assert len(owners) == 1, f"expected exactly one backed-up owner, found {sorted(owners)}"
    return owners.pop()


def _replicate(cli: Cli, settings: Settings, *scope: str) -> None:
    """Replicates one scope to the replica endpoint."""
    cli.ok(
        "replicate",
        *scope,
        "--target-endpoint",
        settings.s3_replica_endpoint,
        "--target-access-key",
        settings.s3_access_key,
        "--target-secret-key",
        settings.s3_secret_key,
    )
