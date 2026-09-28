# Outlook Manifest.created_at is typed Date but is a string at runtime, and the SDK returns it that way from listSnapshots and getSnapshot

**Triage:** RECORD (high confidence, `bug`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

`Manifest.created_at` is declared `Date` (`packages/types/src/domain/manifest.ts:30`). The
backup builds it as a `Date`, `JSON.stringify` writes it as an ISO string, and
`S3ManifestRepository` returns the parsed JSON cast to `Manifest` without converting it back. Every
Outlook manifest read from storage therefore carries a string where the type promises a `Date`.

Inside the repository this is worked around rather than fixed: 12 call sites in 9 files wrap the
value in `new Date(m.created_at)` before using it, and `stats-aggregator.ts:32` re-wraps an
argument already typed `Date`. The compiler cannot flag a missing wrapper, because the type says
none is needed.

The workaround does not reach SDK callers. `outlook.listSnapshots()` and `outlook.getSnapshot()`
return `Camelize<Manifest>`, so `createdAt` is declared `Date`. `camelize` passes it through
unchanged, and a caller that writes `snapshot.createdAt.getTime()` gets
`TypeError: snapshot.createdAt.getTime is not a function`.

The drive twins do this correctly. `S3OneDriveManifestRepository` and
`S3SharePointManifestRepository` rebuild `created_at` with `new Date(...)` and reject an invalid
date with a typed error, so `onedrive.listSnapshots()` returns a real `Date` and
`outlook.listSnapshots()` does not.

## Steps to reproduce

Round trip through the real repository with an identity cipher:

```ts
await repo.save(ctx, { ...manifest, created_at: new Date('2026-09-01T00:00:00Z') });
const back = await repo.find_by_snapshot(ctx, 'snap-1');
typeof back.created_at; // 'string'
back.created_at instanceof Date; // false
```

```
typeof created_at = string false
AssertionError: expected '2026-09-01T00:00:00.000Z' to be an instance of Date
```

From the SDK:

```ts
const [latest] = await atlas.outlook.listSnapshots('john.doe@example.com');
latest.createdAt.getTime(); // TypeError
```

## Expected

A `Manifest` from `S3ManifestRepository` has a `Date` in `created_at`, as the type says and as
the drive repositories already do.

## Actual

It has a string.

## Code references

- `packages/s3/src/adapters/s3-manifest-repository.adapter.ts:157` casts the parsed JSON to
  `Manifest` and returns it at `:161`.
- Twin that is correct: `packages/onedrive/src/adapters/s3-onedrive-manifest-repository.adapter.ts:113`
  (`new Date(parsed.created_at)`, then `InvalidOneDriveManifestDateError` for an invalid value).
- Public type: `packages/types/src/ports/atlas/outlook-api.port.ts:53`
  (`OutlookSnapshotManifest = Camelize<Manifest>`).
- Workarounds that become unnecessary: `new Date(<x>.created_at)` in `catalog.service.ts`,
  `manifest-entry-merger.ts`, `verification.service.ts`, `outlook-manifest-handler.ts`,
  `mailbox-status.service.ts`, `restore.service.ts`, `save.service.ts`,
  `outlook-catalog.handler.tsx`, and `s3-manifest-repository.adapter.ts` itself; plus the
  re-wrap in `stats-aggregator.ts:32`.

## Interface

SDK (the CLI only reads the value through the workarounds).

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

## Acceptance criteria

- `S3ManifestRepository` returns `created_at` as a `Date` from every read path, and rejects an
  unparseable date the way the drive repositories do.
- `outlook.listSnapshots()` and `outlook.getSnapshot()` return `createdAt` as a `Date`.
- A unit test round-trips a manifest through the repository and asserts `instanceof Date`.
- The `new Date(...)` workarounds may stay or go; either way the type is now true.
