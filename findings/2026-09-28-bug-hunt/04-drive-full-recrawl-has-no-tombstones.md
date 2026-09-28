# Drive backup: a full re-crawl records no tombstones, so files deleted before it come back on restore

**Triage:** RECORD (medium confidence, `bug`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

OneDrive and SharePoint snapshots are deltas, and `restore`, `save` and `verify` fold the chain
newest-first (#173). A deleted file stays deleted only because an incremental delta reports the
deletion and the backup writes a `change_type: 'deleted'` entry that wins the fold.

Three paths replace the incremental delta with a full enumeration:

- `--full` (`force_full`)
- a changed `--folder` scope on OneDrive
- a delta reset (`reset_detected`, Graph asking for a resync)

A full enumeration lists what exists. It does not list what was removed since the last run, and
no code compares the enumeration with the files the cursor already tracks. A file deleted between
the last incremental run and the re-crawl therefore gets no tombstone. Its older stored entry is
the newest entry in the chain, and every later snapshot restores, exports and verifies it.

Verified in the code: no path writes a tombstone for a tracked file that is missing from a full
enumeration. Suspected from Graph behaviour: a full driveItem delta does not include deleted
items. That second point is what makes the path reachable.

## Steps to reproduce

1. `atlas onedrive backup -o john.doe@example.com` with `Report.docx` and `Budget.xlsx`.
2. Delete `Budget.xlsx` in OneDrive.
3. `atlas onedrive backup -o john.doe@example.com --full`.
4. `atlas onedrive save -o john.doe@example.com -s <snapshot-2> --output out.zip`.

## Expected

The export matches the drive at snapshot 2: `Report.docx` only.

## Actual (expected from the code)

The export contains both files. The same applies to `restore` and to SharePoint.

## Code references

- `packages/core/src/services/shared/drive-snapshot-chain.ts:132` `fold_drive_snapshot_chain`:
  only an explicit tombstone suppresses an older entry.
- `packages/onedrive/src/services/backup/delta-item-processor.ts:59`
  `clear_file_tracking_on_reset` forgets tracking for returned ids only; tracked ids that were not
  returned are left alone and never tombstoned.
- `packages/sharepoint/src/services/backup/backup-library-processor.ts:50`, the same.
- `packages/onedrive/src/services/backup/backup.service.ts:95`: `force_full` or a scope change
  drops the previous cursor entirely.

`docs/reference/cli.md:546` states that "a restore never resurrects a file the user removed".

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

Found by code reading; not reproduced against a live tenant.

## Acceptance criteria

- Establish with a live run or `graph-tap` capture whether a full driveItem delta omits deleted
  items. If it does not, close this as not reachable.
- After a full enumeration of a drive or library, a file the previous chain holds as stored and
  the enumeration did not return gets a tombstone in the new snapshot.
- The comparison is scoped per drive, and to the `--folder` scope when one is set, so one drive's
  re-crawl never tombstones another drive's files (#199).
- An interrupted enumeration writes no tombstones, since absence proves nothing when the listing
  did not finish.
- Unit tests cover the `--full` path and the reset path for both providers.
