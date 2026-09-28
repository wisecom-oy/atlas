# Deliberate not-found failures are raised as plain Error, so the CLI exits 1 instead of 7 and SDK callers cannot catch NotFoundError

**Triage:** RECORD (high confidence, `bug`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

`docs/reference/sdk.md#errors` says every failure Atlas raises on purpose is an `AtlasError`,
and lists `NotFoundError` (`ATLAS_NOT_FOUND`) for a "snapshot, mailbox, drive, site or object
does not exist". `docs/reference/cli.md#exit-codes` maps that code to exit `7`, and the E2E suite
pins `7` as the documented not-found exit (`e2e/tests/test_35_regressions.py:38`).

Most not-found checks in the services throw `new Error(...)` instead. `handle_fatal_error` finds
no `AtlasError` and no HTTP status on the chain, so the command exits `1`, "unexpected or
unclassified". An SDK caller that follows the documented `instanceof NotFoundError` branch never
matches, and has to match on message text, which the docs tell it not to do.

A mistyped snapshot id is the most common way to hit this, and it lands in the one category the
docs say not to assume anything about.

One adjacent case goes the other way. `atlas outlook delete -s <unknown-id>` finds no manifest,
returns an empty result, prints `Nothing to delete` and exits `0`. The OneDrive and SharePoint
`delete -s` paths do the same, because deleting an absent key succeeds on S3. A script that
erases a named snapshot for a retention or erasure request reads `0` as done.

## Steps to reproduce

1. `atlas outlook restore -s 00000000-0000-0000-0000-000000000000`
2. `echo $?` prints `1`. Expected `7`.
3. `atlas outlook delete -s 00000000-0000-0000-0000-000000000000 --yes`
4. `echo $?` prints `0`, after `Nothing to delete`.

## Expected

Every "does not exist" answer Atlas reaches on purpose is a `NotFoundError`, and the CLI exits
`7`.

## Actual

Exit `1` with no Atlas code in the diagnostic, or exit `0` for delete.

## Code references

Plain `Error` for a missing snapshot manifest:

| Site                                                                           | Command                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `packages/outlook/src/services/restore/restore.service.ts:196`                 | `outlook restore -s`                              |
| `packages/outlook/src/services/save/save.service.ts:145`                       | `outlook save -s`                                 |
| `packages/core/src/services/verification/verification.service.ts:109`          | `outlook verify -s`                               |
| `packages/drive/src/shared/manifest-chain.ts:49`                               | `onedrive` and `sharepoint` restore, save, verify |
| `packages/core/src/services/replication/outlook-manifest-handler.ts:25`        | `replicate`, `rehydrate`                          |
| `packages/core/src/services/replication/onedrive-replication.service.ts:306`   | `replicate`, `rehydrate`                          |
| `packages/core/src/services/replication/sharepoint-replication.service.ts:318` | `replicate`, `rehydrate`                          |

Plain `Error` for other missing resources:

| Site                                                                          | Resource                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/core/src/services/shared/mailbox-assertions.ts:11`                  | mailbox                                                        |
| `packages/outlook/src/services/restore/restore.service.ts:285`                | restore target mailbox (a private copy of the assertion above) |
| `packages/onedrive/src/services/restore/restore.service.ts:78`                | target user's OneDrive                                         |
| `packages/core/src/adapters/identity/caching-identity-resolver.adapter.ts:73` | user, by email                                                 |
| `packages/drive/src/versioning/version-selection.ts:65` and `:75`             | stored file version                                            |

Delete that reports success for an absent snapshot:

- `packages/core/src/services/deletion/deletion.service.ts:75`
- `packages/core/src/services/deletion/onedrive-deletion.service.ts:53`
- `packages/core/src/services/deletion/sharepoint-deletion.service.ts:53`

#40 introduced the taxonomy and #321 the exit categories; neither converted these sites. The
pattern to follow already exists: `packages/s3/src/adapters/tenant-context.factory.ts:65`
raises `NotFoundError` for an unknown tenant, and `packages/m365-graph/src/graph-permission-errors.ts:73`
for an unprovisioned OneDrive.

## Interface

Both (CLI and SDK).

## Environment

```
OS: Ubuntu 24.04.4 LTS
Kernel: 6.18.44-fc-v42
Arch: x86_64
Node: v22.22.2
pnpm: 10.30.3
Atlas: 5.2.2
Git commit: 4d6ee39 (clean)
```

Found by code reading against `fatal-error.ts`; not run against a live bucket.

## Acceptance criteria

- Every site in the tables above raises `NotFoundError`, and the CLI exits `7` for each.
- `outlook restore` uses the shared `assert_mailbox_exists` rather than its own copy.
- `delete -s` with a snapshot id that does not exist raises `NotFoundError` for all three
  workloads, rather than exiting `0` with `Nothing to delete`.
- Deleting a snapshot that exists still exits `0`, and retention still exits non-zero.
- An E2E case alongside `test_01_readonly_commands_provision_nothing` asserts exit `7` for
  `outlook restore -s` and `onedrive verify -s` with an unknown snapshot id.
- `docs/reference/sdk.md` and `docs/reference/cli.md` need no change: this brings the code in
  line with them.
