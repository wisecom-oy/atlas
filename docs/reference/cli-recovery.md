# Recovery and management workflows

The recovery commands (`verify`, `restore`, `save`, `delete`, `replicate`, and `rehydrate`) are documented flag by flag in [CLI commands](/reference/cli). This page covers how to combine them. These operations are infrequent and high stakes, so the order matters.

## Verify before you restore

Run [`atlas outlook verify`](/reference/cli#atlas-outlook-verify) on a snapshot before you rely on it. Verification walks the snapshot's merged manifest chain, decrypts and re-hashes every referenced object (message bodies and attachments), and compares each against its manifest checksum. A corrupt object from an older backup fails every later snapshot that references it, so verify the snapshot you plan to restore, not only the latest one.

For a compliance export or legal hold, use [`atlas outlook save`](/reference/cli#atlas-outlook-save) instead of restore. It writes standard `.eml` files into a zip archive without touching the Microsoft 365 mailbox, and it SHA-256 verifies every message after decryption.

[`atlas outlook restore`](/reference/cli#atlas-outlook-restore) has two modes. Snapshot mode restores one snapshot. Mailbox mode combines every snapshot for a mailbox, deduplicates them, and restores the result. Passing both `--snapshot` and `--mailbox` is refused. To choose a different destination mailbox, pass `--target`, so a cross-mailbox restore is always a deliberate choice.

## Deleting data safely

[`atlas outlook delete`](/reference/cli#atlas-outlook-delete) removes manifests first, then data objects. If a delete is interrupted, you are left with harmless orphan blobs rather than manifests that point at missing data. Plan around three consequences:

- Deleting one snapshot removes only its manifest. The data objects stay, because other snapshots may reference them.
- `atlas delete --purge` deletes everything in the tenant bucket, including the encrypted data key at `_meta/dek.enc`. All data for the tenant becomes permanently inaccessible across Outlook, OneDrive, and SharePoint.
- When Object Lock retention protects objects, delete exits non-zero and reports retained items separately from real failures. Retained items become deletable when retention expires.

## Replication and disaster recovery

Run [`atlas replicate`](/reference/cli#atlas-replicate) on a schedule against a secondary S3 target. Ciphertext is copied as-is, so the replica never sees plaintext. Each transfer covers only unreplicated snapshots and missing objects. See [Replication](/operations/replication) for target layout and scheduling.

[`atlas rehydrate`](/reference/cli#atlas-rehydrate) is the reverse path for disaster recovery, from replica to primary. It is not a bidirectional sync. It copies the snapshots you select, skips anything already on primary, and does not merge or resolve conflicts. Check two things before you run it:

- Rehydration needs the replica's encryption key on primary. Atlas copies the key automatically into an empty bucket, or into a freshly initialized bucket whose only object is that key. Otherwise it aborts with `DekOverwriteRefusedError` rather than overwrite a key that protects existing data. If primary's content is disposable, run `atlas delete --purge` first, then rehydrate into the empty bucket.
- Delta links in recovered manifests can be stale. Atlas falls back to a full sync on the next backup automatically, so that first backup takes longer.

## See also

- [CLI commands](/reference/cli): full flag reference for every command
- [OneDrive backup](/onedrive-backup): OneDrive restore, save, and verify
- [SharePoint backup](/sharepoint-backup): SharePoint restore, save, and verify
- [Replication](/operations/replication): the replication and rehydration process in operational detail
