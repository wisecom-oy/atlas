"""The SDK's own contract: validation, typed errors, listings and storage request events.

`test_35` only proves the published bundle imports and lists snapshots. A hosted product calls
far more of it, and the SDK has behaviour the CLI never reaches: construction-time validation,
typed errors on the thrown object, the `createTenant` handle and storage request events. Each
script in `e2e/sdk/` exercises one of those and prints counts, flags and codes, which these tests
compare with S3 keys and Graph state. Nothing here writes to Microsoft 365 or to the bucket.

Depends on `test_10` and `test_12` (the Outlook snapshots), `test_20` and `test_22` for OneDrive,
and `test_14`, `test_16` and `test_30` for listing their workloads when they ran. Runs after
`test_35`. Backups, cancellation, verify and restore through the SDK follow in
`test_36_sdk_runs.py`.
"""

from __future__ import annotations

import json
import secrets
import uuid
from typing import Any

import pytest

from atlas_e2e import probe, sdk, storage
from atlas_e2e.config import Settings
from atlas_e2e.graph import Graph

STATE: dict[str, Any] = {}

NOT_FOUND = "ATLAS_NOT_FOUND"
CONFIG_INVALID = "ATLAS_CONFIG_INVALID"
# Valid GUIDs that were certainly never backed up and name no Entra object.
UNKNOWN_SNAPSHOT = str(uuid.UUID(int=0))
UNKNOWN_OWNER = str(uuid.UUID(int=0xE2E))


@pytest.fixture(scope="module", autouse=True)
def _outlook_snapshots(settings: Settings, s3: Any) -> None:
    """Reads the mailbox owner segment and the oldest-keyed snapshot the Outlook suites left."""
    STATE["owner"] = sdk.sole_owner(s3, settings, "outlook")
    snapshots = sorted(sdk.snapshots_of(s3, settings, STATE["owner"]))
    assert snapshots, "test_10_outlook left no snapshot to work on"
    STATE["snapshot"] = snapshots[0]


def _assert_refused(outcome: dict[str, Any], code: str | None, error_class: str) -> None:
    """The call threw an instance of `error_class` carrying `code`."""
    assert outcome["thrown"], "the call resolved instead of rejecting"
    assert outcome["code"] == code, outcome
    assert error_class in outcome["classes"], outcome


def test_01_invalid_configuration_is_refused_at_construction(settings: Settings) -> None:
    """Each invalid field throws `ConfigError` from `createAtlasInstance`, before any request."""
    data = sdk.ok(settings, "config-errors.mjs")
    assert len(data) == 6, sorted(data)
    for outcome in data.values():
        _assert_refused(outcome, CONFIG_INVALID, "ConfigError")


def test_02_restore_options_are_refused_before_storage_is_read(settings: Settings) -> None:
    """Blank or mailbox-wide `messageRef` and a `targetTenant` without a target fail first.

    A host that forwards user input should get the refusal without the call having read the
    bucket or written anything, so zero S3 requests is part of the assertion.
    """
    data = sdk.ok(
        settings,
        "call-guards.mjs",
        {"E2E_SNAPSHOT_ID": STATE["snapshot"], "E2E_MAILBOX": settings.mailbox},
    )
    _assert_refused(data["blank_message_ref"], CONFIG_INVALID, "ConfigError")
    _assert_refused(data["message_ref_for_a_mailbox"], CONFIG_INVALID, "ConfigError")
    _assert_refused(data["target_tenant_without_target"], None, "TypeError")
    _assert_refused(data["target_tenant_not_a_handle"], CONFIG_INVALID, "ConfigError")
    assert data["storage_requests"] == 0, f"{data['storage_requests']} S3 request(s) were sent"


def test_03_create_tenant_checks_formats_and_keeps_the_secret_private(settings: Settings) -> None:
    """`createTenant` validates offline, never renders its secret, and gets a Graph token."""
    data = sdk.ok(settings, "tenant-handle.mjs")
    assert data["tenant_id_kept"] and data["client_id_kept"]
    assert not data["secret_rendered"], "the handle printed its client secret"
    assert data["validate"] == {"thrown": False}, data["validate"]
    for case in ("tenant_id_malformed", "client_id_malformed", "secret_with_whitespace"):
        _assert_refused(data[case], CONFIG_INVALID, "ConfigError")
    _assert_refused(data["no_config"], CONFIG_INVALID, "ConfigError")


def test_04_a_wrong_passphrase_is_a_typed_error(settings: Settings) -> None:
    """`validate()` and a listing both reject with `ATLAS_WRONG_PASSPHRASE`, not a crypto error.

    The correct passphrase validates in the same run, so the refusal is about the key alone.
    """
    wrong = secrets.token_urlsafe(24)
    assert wrong != settings.passphrase
    data = sdk.ok(
        settings,
        "wrong-passphrase.mjs",
        {"E2E_OWNER_ID": STATE["owner"], "E2E_WRONG_PASSPHRASE": wrong},
    )
    _assert_refused(data["validate_wrong"], "ATLAS_WRONG_PASSPHRASE", "WrongPassphraseError")
    _assert_refused(data["listing_wrong"], "ATLAS_WRONG_PASSPHRASE", "WrongPassphraseError")
    assert data["validate_right"] == {"thrown": False}, data["validate_right"]


def test_05_listings_match_the_manifest_keys(settings: Settings, s3: Any) -> None:
    """Both listing methods of every backed-up workload name exactly the snapshots in S3."""
    expected = {"outlook": sdk.snapshots_of(s3, settings, STATE["owner"])}
    env = {"E2E_MAILBOX": settings.mailbox}
    configured = {
        "onedrive": ("E2E_ONEDRIVE_OWNER", settings.onedrive_owner),
        "sharepoint": ("E2E_SHAREPOINT_SITE", settings.sharepoint_site),
    }
    for workload, (variable, identifier) in configured.items():
        if identifier:
            env[variable] = identifier
            expected[workload] = _workload_snapshots(settings, s3, workload)
    # Contacts and calendar skip themselves without the Graph permission, so they are listed only
    # when their suite left manifests behind.
    for workload in ("contacts", "calendar"):
        if storage.owner_segments(s3, settings.bucket, workload):
            env[f"E2E_LIST_{workload.upper()}"] = "1"
            expected[workload] = _workload_snapshots(settings, s3, workload)

    listed = sdk.ok(settings, "listings.mjs", env)

    assert set(listed) == set(expected), sorted(listed)
    for workload, ids in expected.items():
        for method in ("snapshots", "summaries"):
            got = set(listed[workload][method])
            assert got == ids, f"{workload} {method}: SDK {len(got)}, bucket {len(ids)}"


def _workload_snapshots(settings: Settings, s3: Any, workload: str) -> set[str]:
    """Snapshot ids of the one owner or site a workload suite backed up."""
    return sdk.snapshots_of(s3, settings, sdk.sole_owner(s3, settings, workload), workload)


def test_06_storage_events_describe_a_read_without_identifiers(settings: Settings) -> None:
    """A fast verify reports typed v7 events with no `target`, no key and no secret.

    Fast verify sends `HeadObject` per stored object, which the docs say carries no `bytes`.
    """
    data = sdk.ok(settings, "storage-events.mjs", {"E2E_SNAPSHOT_ID": STATE["snapshot"]})
    events: list[dict[str, Any]] = data["events"]

    assert data["verify"]["failed"] == 0, data["verify"]
    assert events, "no storage request event was emitted"
    problems = sdk.storage_event_problems(events)
    assert not problems, problems[:10]
    assert not [e for e in events if "target" in e], "an event carries the removed `target`"
    assert {e.get("operation") for e in events} == {"verify"}
    heads = [e for e in events if e["command"] == "HeadObject"]
    assert [e for e in heads if e["keyClass"] == "data"], "no HeadObject on a data object"
    assert not [e for e in heads if "bytes" in e], "a HeadObject event reports bytes"
    assert [e for e in events if e["keyClass"] == "manifests"], "no manifest request reported"

    leaked = sdk.leaked_values(
        json.dumps(events),
        {
            "passphrase": settings.passphrase,
            "client secret": settings.client_secret,
            "client id": settings.client_id,
            "tenant id": settings.tenant_id,
            "bucket": settings.bucket,
            "s3 endpoint": settings.s3_endpoint,
            "s3 access key": settings.s3_access_key,
            "s3 secret key": settings.s3_secret_key,
            "mailbox": settings.mailbox,
            "owner id": STATE["owner"],
            "snapshot id": STATE["snapshot"],
        },
    )
    assert not leaked, f"storage events carry: {leaked}"


def test_07_unknown_snapshot_and_mailbox_are_not_found(
    settings: Settings, s3: Any, graph: Graph, run_marker: str
) -> None:
    """Each lookup of something absent rejects with `NotFoundError`, before anything is written."""
    destination = f"{run_marker}-sdk-none"
    before = sdk.snapshots_of(s3, settings, STATE["owner"])
    data = sdk.ok(
        settings,
        "errors.mjs",
        {
            "E2E_RUN_MARKER": run_marker,
            "E2E_SNAPSHOT_ID": STATE["snapshot"],
            "E2E_UNKNOWN_SNAPSHOT": UNKNOWN_SNAPSHOT,
            "E2E_UNKNOWN_OWNER": UNKNOWN_OWNER,
            "E2E_DESTINATION": destination,
        },
    )
    assert len(data) == 5, sorted(data)
    for outcome in data.values():
        _assert_refused(outcome, NOT_FOUND, "NotFoundError")
    assert sdk.snapshots_of(s3, settings, STATE["owner"]) == before
    assert probe.find_top_level_folder(graph, settings.mailbox, destination) is None, (
        "a refused restore still created its destination"
    )


def test_08_list_permissions_names_the_shared_file(
    settings: Settings, s3: Any, run_marker: str
) -> None:
    """The newest OneDrive snapshot records the organization link `test_22` created."""
    if not settings.onedrive_owner:
        pytest.skip("E2E_ONEDRIVE_OWNER not set")
    data = sdk.ok(
        settings,
        "permissions.mjs",
        {"E2E_ONEDRIVE_OWNER": settings.onedrive_owner, "E2E_RUN_MARKER": run_marker},
    )
    assert data["snapshot_id"] in _workload_snapshots(settings, s3, "onedrive")
    shared = [i for i in data["marked_items"] if i["path"].endswith(f"/{run_marker}-shared.bin")]
    assert shared, "the shared fixture file has no captured permissions"
    assert any({"type": "view", "scope": "organization"} in i["links"] for i in shared), shared
