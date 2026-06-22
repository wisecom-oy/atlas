# CLI — Recovery & Management

Reference for Atlas commands used in restore, export, integrity verification, data deletion, and replication workflows. These are less frequent, higher-stakes operations -- read the notes carefully before running commands that modify or delete data.

For day-to-day backup, status, and inspection commands, see [CLI Commands](/reference/cli).

## `atlas outlook verify`

Verify integrity of an Outlook backup snapshot. Downloads every encrypted object from S3, decrypts it (which validates the GCM authentication tag against tampering), recomputes the SHA-256 hash of the plaintext, and compares it against the checksum stored in the manifest using constant-time comparison (`timingSafeEqual`).

```bash
atlas outlook verify -m user@company.com -s <snapshot-id>
atlas outlook verify -m user@company.com -s <snapshot-id> -t <tenant-id>
```

::: details What exactly is verified?
`atlas outlook verify` checks **message body entries** listed in the manifest. Each message is downloaded, decrypted (GCM auth tag validates ciphertext integrity), and its plaintext SHA-256 is compared against the manifest checksum.

Attachments are **not separately verified** by this command. However, attachments are protected by GCM authentication -- any tampering will cause a decryption failure during restore or save operations. The verification scope is message bodies because those are the primary data objects tracked in manifests.
:::

For OneDrive and SharePoint verification, see `atlas onedrive verify` and `atlas sharepoint verify` in [CLI Commands](/reference/cli).

## `atlas outlook restore`

Restore emails from backup to an M365 mailbox.

**Snapshot mode** -- restore from a specific snapshot:

```bash
atlas outlook restore -s <snapshot-id>
atlas outlook restore -s <snapshot-id> -f Inbox
atlas outlook restore -s <snapshot-id> --message 42
atlas outlook restore -s <snapshot-id> -T target@company.com
```

**Mailbox mode** -- aggregate all snapshots for a mailbox, deduplicate, and restore:

```bash
atlas outlook restore -m user@company.com
atlas outlook restore -m user@company.com -f Inbox
atlas outlook restore -m user@company.com --start-date 2026-01-01
atlas outlook restore -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
atlas outlook restore -m user@company.com -T other@company.com
atlas outlook restore -m user@company.com -T other@company.com -f Inbox
```

| Option                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `-s, --snapshot <id>`       | Restore from a specific snapshot                              |
| `-m, --mailbox <email>`     | Restore from all snapshots for this mailbox                   |
| `-T, --target <email>`      | Target mailbox for cross-mailbox restore (defaults to source) |
| `-f, --folder <name>`       | Restore only messages from this folder                        |
| `--message <ref>`           | Restore a single message by `#` index from `atlas outlook list` |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date               |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date              |
| `-t, --tenant <id>`         | Override tenant ID                                            |

Either `--snapshot` or `--mailbox` is required. Using both `--snapshot` and `--mailbox` together requires `--target` (`-T`) to explicitly specify the restore destination. In mailbox mode, entries are deduplicated across snapshots (newest version of each message wins). Cross-mailbox restores preserve the original folder names from the source mailbox.

Restored messages retain their original received/sent timestamps, appear as received mail (not drafts), and include all backed-up attachments. Large attachments (>3 MB) use Graph upload sessions with chunked transfer.

## `atlas outlook save`

Export backed-up emails as standard `.eml` files (RFC 5322) in a compressed zip archive. Messages include all backed-up attachments embedded as MIME parts. Every message and attachment is SHA-256 verified after decryption by default.

**Snapshot mode:**

```bash
atlas outlook save -s <snapshot-id>
atlas outlook save -s <snapshot-id> -f Inbox
atlas outlook save -s <snapshot-id> --message 42
atlas outlook save -s <snapshot-id> -o ~/Downloads/backup.zip
atlas outlook save -s <snapshot-id> --skip-verify
```

**Mailbox mode:**

```bash
atlas outlook save -m user@company.com
atlas outlook save -m user@company.com -f Inbox
atlas outlook save -m user@company.com --start-date 2026-01-01
atlas outlook save -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
```

| Option                      | Description                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `-s, --snapshot <id>`       | Save from a specific snapshot                               |
| `-m, --mailbox <email>`     | Save from all snapshots for this mailbox                    |
| `-f, --folder <name>`       | Save only messages from this folder                         |
| `--message <ref>`           | Save a single message by `#` index from `atlas outlook list` |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date             |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date            |
| `-o, --output <path>`       | Output file path (default: `Restore-<timestamp>.zip`)       |
| `--skip-verify`             | Skip SHA-256 integrity checks (faster on low-power systems) |
| `-t, --tenant <id>`         | Override tenant ID                                          |

The zip archive mirrors the Outlook folder hierarchy:

```
Restore-2026-03-10T14-30-00.zip
  Inbox/
    2026-03-10_143022_Meeting-with-client.eml
    2026-03-10_090115_Weekly-report.eml
  Sent Items/
    2026-03-09_161200_Re-Project-update.eml
  Archive/
    2026-01-15_080000_Old-thread.eml
```

EML filenames use the format `YYYY-MM-DD_HHmmss_Sanitized-subject.eml` with timestamps from `receivedDateTime` for natural chronological sorting. Duplicate filenames within a folder get numeric suffixes (`_1`, `_2`).

If the output file already exists, Atlas prompts `Overwrite? [Y/n]` before proceeding.

## `atlas outlook delete`

Delete backed-up Outlook data with confirmation prompt.

```bash
atlas outlook delete -m user@company.com        # delete all data + manifests for a mailbox
atlas outlook delete -s <snapshot-id>           # delete one snapshot manifest (data retained)
atlas outlook delete --purge                    # delete EVERYTHING in the tenant bucket
atlas outlook delete --purge -y                 # skip confirmation prompt
```

| Option                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `-m, --mailbox <email>` | Delete all data, attachments, and manifests for a mailbox      |
| `-s, --snapshot <id>`   | Delete a single snapshot manifest (data objects retained)      |
| `--purge`               | Delete all data, manifests, and encryption keys (irreversible) |
| `-y, --yes`             | Skip confirmation prompt                                       |
| `-t, --tenant <id>`     | Override tenant ID                                             |

When Object Lock retention protects objects, delete commands return non-zero and report retained items separately from generic failures.

::: details Deletion ordering
Atlas deletes **manifests first**, then data objects. This ordering is safe: if deletion is interrupted mid-way, you are left with orphan data blobs (harmless, can be cleaned up later) rather than dangling manifest references that point to missing data.

When using `--snapshot`, only the manifest file is removed -- the underlying data objects are retained because they may be referenced by other snapshots (content-addressed deduplication).

When using `--purge`, **everything** is deleted including the encrypted DEK at `_meta/dek.enc`. This is irreversible -- all data for the tenant becomes permanently inaccessible.

`--purge` and mailbox-wide delete (`-m`) list and delete objects by key only: they do **not** need to unwrap `_meta/dek.enc`. You can use them to empty a bucket even when the wrapped DEK blob is missing, corrupt, or from an older format (you still cannot decrypt data without a valid passphrase and blob).
:::

## `atlas replicate`

Replicate snapshots to a secondary S3-compatible storage target. Ciphertext is copied as-is (no decryption). Only unreplicated snapshots and missing objects are transferred.

```bash
atlas replicate -s <snapshot-id> \
  --target-endpoint http://offsite:9000 \
  --target-access-key <key> \
  --target-secret-key <secret>

atlas replicate -m user@company.com --target-config ./offsite.json

atlas replicate --site https://contoso.sharepoint.com/sites/Engineering --target-config ./offsite.json
atlas replicate --site contoso.sharepoint.com,guid,guid -s sp-snap-1735689600000-a1b2c3 --target-config ./offsite.json

atlas replicate --status
atlas replicate --status -m user@company.com
atlas replicate --status -s <snapshot-id>
atlas replicate --status --site https://contoso.sharepoint.com/sites/Engineering
```

| Option                       | Description                                           |
| ---------------------------- | ----------------------------------------------------- |
| `-s, --snapshot <id>`        | Replicate a specific snapshot                         |
| `-m, --mailbox <email>`      | Replicate all unreplicated snapshots for a mailbox    |
| `--site <url-or-id>`         | Replicate all unreplicated snapshots for a SharePoint site |
| `--target-endpoint <url>`    | Target S3 endpoint URL                                |
| `--target-access-key <key>`  | Target S3 access key                                  |
| `--target-secret-key <key>`  | Target S3 secret key                                  |
| `--target-region <region>`   | Target S3 region (default: `us-east-1`)               |
| `--target-config <path>`     | Path to JSON file with target S3 credentials          |
| `--status`                   | Show replication status instead of replicating        |
| `-t, --tenant <id>`          | Override tenant ID                                    |

::: tip Target Config File
The target config file is a JSON object with `s3_endpoint`, `s3_access_key`, `s3_secret_key`, and optionally `s3_region` and `target_id`. The encryption passphrase is shared from the main Atlas configuration.
:::

## `atlas rehydrate`

Recover snapshots from a replica to primary storage. This is a disaster recovery operation -- not a bidirectional sync. Snapshots already on primary are skipped.

```bash
atlas rehydrate -s <snapshot-id> \
  --source-endpoint http://offsite:9000 \
  --source-access-key <key> \
  --source-secret-key <secret>

atlas rehydrate -m user@company.com --source-config ./offsite.json
atlas rehydrate --all --source-config ./offsite.json

atlas rehydrate --site https://contoso.sharepoint.com/sites/Engineering --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,guid,guid -s sp-snap-1735689600000-a1b2c3 --source-config ./offsite.json
```

| Option                       | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `-s, --snapshot <id>`        | Recover a specific snapshot from the replica             |
| `-m, --mailbox <email>`      | Recover all snapshots for a mailbox from the replica     |
| `--site <url-or-id>`         | Recover all SharePoint snapshots for a site from the replica |
| `--all`                      | Recover all mailboxes and snapshots (full tenant DR)     |
| `--source-endpoint <url>`    | Source replica S3 endpoint URL                           |
| `--source-access-key <key>`  | Source replica S3 access key                             |
| `--source-secret-key <key>`  | Source replica S3 secret key                             |
| `--source-region <region>`   | Source replica S3 region (default: `us-east-1`)          |
| `--source-config <path>`     | Path to JSON file with source S3 credentials             |
| `-t, --tenant <id>`          | Override tenant ID                                       |

::: danger Rehydration Is Not Sync
Rehydration copies explicitly selected data from a designated replica to primary. It does not merge, diff, or resolve conflicts. After rehydration, primary resumes as the source of truth. Delta links in recovered manifests may be stale -- Atlas falls back to full sync on the next backup automatically.
:::

## See Also

- [CLI Commands](/reference/cli) — `backup`, `status`, `mailboxes`, `storage-check`, `list`, `read`, `stats` for all workloads
- [OneDrive Backup](/onedrive-backup) — OneDrive restore, save, and verify
- [SharePoint Backup](/sharepoint-backup) — SharePoint restore, save, and verify
- [Replication](/operations/replication) — full operational detail on the replication and rehydration engine
