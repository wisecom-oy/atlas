# OneDrive backup: a mid-drive failure discards the drive's entries but saves their tracking state, so the next run skips those files for good

**Triage:** RECORD (high confidence, `bug`, `priority: high`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

When `process_delta_item` throws for a OneDrive item, the exception leaves
`process_single_drive` and is caught per drive in `scan_all_drives`. The drive's entries are
discarded and its delta link is not advanced, which is meant to make the next run replay the
batch.

The replay does not recover the files processed before the throw. `process_delta_item` records
each successful file's path, name and ETag into the shared `tracking_state` as it goes. That
state is not rolled back when the drive fails, and `backup_onedrive` saves it into the delta
cursor at the end of the run. On the next run the replayed delta presents the same items with
the same ETags, `classify_drive_change` finds nothing changed, and the items are skipped. Their
blobs are in the bucket, but no manifest ever references them.

The first run exits 2 with a drive error. The second run is healthy and exits 0. From then on a
restore returns the older version of each affected file, or nothing for a file that was new, and
`verify` reports healthy because it only checks what manifests reference.

Triggers are anything `process_delta_item` rethrows for a small file: a storage `put` or `exists`
failure after the S3 client's own retries, or a missing Graph grant that
`download_with_retry` deliberately rethrows (#246).

SharePoint does not have this defect. `process_item_guarded` catches every per-item failure except
cancellation and records it in the failed-item ledger, so one item's error never discards the
library's entries.

## Steps to reproduce

Unit reproduction against `scan_all_drives` with the real `process_delta_item`, mocking only
`process_backup_file` and `version-sync`:

1. A drive delta returns files `a` and `b`, each with an ETag.
2. Run 1: `a` stores; `b` rejects with `S3 PutObject: 503 SlowDown`.
3. Run 2: same delta (the link did not advance), same tracking state; both files now store.

```
run1 entries [] errors [ 'Drive Documents (d1): S3 PutObject: 503 SlowDown' ] links {} etags { a: 'etag-a' }
run2 entries [ 'b' ] errors [] failed []
AssertionError: expected [ 'b' ] to include 'a'
```

File `a` is in no manifest from either run, and run 2 reports no errors and no failed items.

## Expected

A file whose entry was discarded is either recorded in a manifest on a later run or tracked in
the failed-item ledger until it is.

## Actual

The file is silently skipped by every later incremental run until its content changes again.

## Code references

- `packages/onedrive/src/services/backup/delta-item-processor.ts:148` writes tracking state for
  the item before the drive has succeeded.
- `packages/onedrive/src/services/backup/backup-drive-processor.ts:197` catches the drive failure
  and drops `drive_result`, entries included.
- `packages/onedrive/src/services/backup/backup.service.ts:182` spreads the mutated
  `tracking_state` into the cursor, saved at `:223` (no entries) or through
  `persist_snapshot_backup` (other drives had entries).
- `packages/drive/src/backup/change-classifier.ts:250` returns `undefined` for a known item whose
  ETag is unchanged.
- Twin that is correct: `packages/sharepoint/src/services/backup/library-item-processor.ts`
  `process_item_guarded`.

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

## Acceptance criteria

- A OneDrive file processed before a drive-level failure is recorded in a manifest by a later
  run, or held in the failed-item ledger until it is.
- Either per-item failures are contained the way SharePoint contains them, or tracking state for
  a failed drive is not persisted. Which one is a design choice; the negative case below holds
  either way.
- A missing grant still stops the run with the typed permission error rather than degrading to a
  per-file skip (#246).
- A cancelled transfer still does not consume a ledger attempt (#344).
- A unit test pins the two-run scenario above: run 1 fails mid-drive, run 2 records every file
  run 1 did not.
