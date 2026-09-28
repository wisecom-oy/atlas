# Drive delta cursors and the identity registry treat any read failure as "no state yet", and the next save overwrites the real state

**Triage:** RECORD (high confidence, `bug`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

Three repositories load one encrypted state object and catch every failure after the key is
known to exist, returning `undefined`:

- `S3OneDriveDeltaCursorRepository.load`
- `S3SharePointDeltaCursorRepository.load`
- `S3IdentityRegistryRepository.load`

`undefined` is what these return when no state exists yet, so a `503`, a `403`, a network
reset, a failed AES-GCM tag or a truncated object all read as "first run". The run then proceeds
and, when it finishes, writes fresh state over the object it could not read. No error, no
warning, exit `0`.

This is the pattern the manifest repository was moved away from in #340 and #341: "Absence is
the only recoverable outcome. A manifest that failed to decrypt, parse or identify is damaged,
and returning `undefined` for it reports a broken backup with the same value as a snapshot that
was never taken" (`packages/s3/src/adapters/s3-manifest-repository.adapter.ts:163`).

What each one costs:

**Drive cursors.** The backup runs as though the owner or site was never backed up. Every file
is downloaded again (dedup happens after the download), the failed-item ledger and path, name
and ETag tracking are dropped, and deletions since the last run get no tombstone (#435). The run
is healthy and saves a new cursor over the old one.

**Identity registry.** `CachingIdentityResolver.ensure_loaded` starts from an empty registry.
The first identity registered afterwards calls `persist`, which saves the in-memory list of one
entry over `identity-registry.json`. Every earlier entry is gone, including `recycled` records
and the cached identities of users who have left the tenant. `resolve_user` falls back to that
cache when Graph no longer knows a user, so after the overwrite `atlas onedrive restore -o
<departed-user-email>` fails with "user not found in Microsoft Graph and no cached identity
exists".

A decrypt failure is also evidence of tampering or corruption. Overwriting it silently removes
that evidence.

## Steps to reproduce

1. Back up a OneDrive owner twice so a cursor exists.
2. Make `GetObject` on `onedrive/_meta/<owner>/delta.json` fail once (a proxy returning `503`, or
   replace the object with bytes that fail the tag).
3. `atlas onedrive backup -o john.doe@example.com`

## Expected

A cursor or registry that exists and cannot be read stops the run with the documented error:
`StorageError` for a storage failure (exit `1`, or `3`/`4` from its cause), and a distinct error
for content that fails to decrypt or parse.

## Actual

The backup re-downloads the whole drive, reports healthy, exits `0`, and replaces the cursor.

## Code references

- `packages/onedrive/src/adapters/s3-onedrive-delta-cursor-repository.adapter.ts:22`
- `packages/sharepoint/src/adapters/s3-sharepoint-delta-cursor-repository.adapter.ts:22`
- `packages/s3/src/adapters/s3-identity-registry-repository.adapter.ts:23`
- `packages/core/src/adapters/identity/caching-identity-resolver.adapter.ts:163` loads an empty
  registry on `undefined`, and `:158` `persist` saves the in-memory list.
- Reference: `packages/s3/src/adapters/s3-manifest-repository.adapter.ts:150`, which lets only
  `is_absent_object_error` through as `undefined` and wraps the rest in `StorageError`.

The Outlook cursor (`s3-mailbox-delta-cursor-repository.adapter.ts:32`) has the same catch, on
purpose: its fallback is the manifest's delta links, and the comment says so. It is out of scope
here.

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

Found by code reading; not reproduced against a live bucket.

## Acceptance criteria

- The three `load` methods return `undefined` only for an absent object. Any other failure is
  raised: `StorageError` with the S3 error as `cause` for a storage failure, and an
  `AtlasError` that names corruption for content that fails to decrypt or parse.
- A backup whose cursor exists but cannot be read fails without writing a new cursor.
- `CachingIdentityResolver` never persists a registry it did not load successfully.
- Unit tests for each repository pin the three outcomes: absent, readable, and present but
  unreadable.
