# Recovery and Management Workflows

The recovery commands (`verify`, `restore`, `save`, `delete`, `replicate`, `rehydrate`) are documented flag by flag in [CLI Commands](/reference/cli). This page covers how to combine them, because these are infrequent, high-stakes operations where ordering matters.

## Verify before you restore

Run [`atlas outlook verify`](/reference/cli#atlas-outlook-verify) against a snapshot before you trust it for a restore. Verification walks the snapshot's merged manifest chain, downloads and decrypts every referenced object (message bodies and attachments), and re-hashes each one against the manifest checksum. A corrupt object from an older backup fails every later snapshot that references it, so verify the snapshot you intend to restore, not just the latest one.

For a compliance export or legal hold, use [`atlas outlook save`](/reference/cli#atlas-outlook-save) instead of restore: it writes standard `.eml` files into a zip archive without touching the M365 mailbox, and SHA-256 verifies every message after decryption.

[`atlas outlook restore`](/reference/cli#atlas-outlook-restore) offers two modes. Snapshot mode restores one snapshot; mailbox mode aggregates every snapshot for a mailbox, deduplicates, and restores. Combining `--snapshot` with `--mailbox` requires `--target`, so a cross-mailbox restore is always an explicit decision.

## Deleting data safely

[`atlas outlook delete`](/reference/cli#atlas-outlook-delete) removes manifests first, then data objects. If deletion is interrupted, you are left with harmless orphan blobs rather than dangling manifest references. Three consequences to plan around:

- Deleting one snapshot removes only its manifest. The data objects stay, because content-addressed deduplication means other snapshots may reference them.
- `--purge` deletes everything in the tenant bucket, including the encrypted DEK at `_meta/dek.enc`. All data for the tenant becomes permanently inaccessible, across Outlook, OneDrive, and SharePoint.
- When Object Lock retention protects objects, delete exits non-zero and reports retained items separately from real failures. Retained items become deletable when retention expires.

## Replication and disaster recovery

Run [`atlas replicate`](/reference/cli#atlas-replicate) on a schedule against a secondary S3 target. Ciphertext is copied as-is, so the replica needs no passphrase and the transfer only covers unreplicated snapshots and missing objects. See [Replication](/operations/replication) for target layout and scheduling.

[`atlas rehydrate`](/reference/cli#atlas-rehydrate) is the reverse path for disaster recovery, from replica back to primary. It is not a bidirectional sync: it copies the snapshots you select, skips anything already on primary, and does not merge or resolve conflicts. Two things to check before running it:

- Rehydration needs the replica's encryption key on primary. Atlas copies it automatically only into an empty bucket and aborts with `DekOverwriteRefusedError` rather than overwrite a key that protects existing data. If the primary's content is disposable, purge it first.
- Delta links in recovered manifests may be stale. Atlas falls back to a full sync on the next backup automatically, so the first backup after a rehydration takes longer.

## See also

- [CLI Commands](/reference/cli): full flag reference for every command
- [OneDrive Backup](/onedrive-backup): OneDrive restore, save, and verify
- [SharePoint Backup](/sharepoint-backup): SharePoint restore, save, and verify
- [Replication](/operations/replication): the replication and rehydration engine in operational detail
