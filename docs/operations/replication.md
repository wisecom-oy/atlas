---
description: Copy completed Atlas snapshots from your primary bucket to secondary S3-compatible targets with atlas replicate, including safety rules and disaster recovery.
---

# Replication

Replication copies completed snapshots from your primary bucket to one or more secondary S3-compatible targets. It is built into Atlas and needs no external sync tool.

```bash
atlas replicate -s <snapshot-id> --target-config ./offsite.json
```

## How replication works

For each snapshot, Atlas:

1. Reads the snapshot manifest from primary storage.
2. Checks which of the manifest's objects (messages, attachments, and file data) the target already holds.
3. Copies the missing objects as raw ciphertext. Nothing is decrypted or re-encrypted.
4. Copies the manifest **last**, so a target never holds a manifest that points at missing objects.
5. Writes a status record to primary storage with the outcome.

Replication is **idempotent**. Running it again skips objects the target already has, so retrying after a failure or interruption is safe.

### Copy order and crash safety

| Step | Object                                      | Notes                                                                                           |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1    | DEK validation                              | Passes when the target has no key yet. Refuses before any write if the key differs.             |
| 2    | `_meta/dek.enc`                             | Copied to the target if absent.                                                                 |
| 3    | `_meta/replica.marker`                      | Written to the target. Rehydration to primary skips it.                                         |
| 4    | Data and attachment objects                 | Copied in manifest order, skipping objects already present.                                     |
| 5    | Ancillary objects (OneDrive and SharePoint) | File version indexes and delta cursors.                                                         |
| 6    | Manifest                                    | **Always last.**                                                                                |

If replication stops at any point, the target holds some orphan data objects, which are harmless and can be reclaimed. No manifest references a missing object. The next run resumes where the last one stopped.

A run that finishes with failures follows the same rule. If any object fails to copy, Atlas does not write the manifest. The snapshot remains unreplicated, and the next run retries it. Mailbox, owner, and site runs decide which snapshots need replicating by checking for their manifests on the target. A manifest written after a partial copy would make the gap permanent: later runs would report nothing to do while objects stayed missing.

## Safety model

### Primary is authoritative

::: danger Never back up to a replica
Primary storage is the source of truth during normal operation. Targets receive data only through replication. Do not run `atlas outlook backup` or other backup commands against a replica bucket. Atlas detects the replica marker and logs a warning when it happens.
:::

Replication flows one way, from primary to target. Atlas performs no bidirectional sync and no conflict resolution. Recovering data from a target is a separate, explicit operation: [rehydration](#rehydration-disaster-recovery).

### Shared encryption

All copies use the same passphrase and the same per-tenant data-encryption key (DEK). Ciphertext is copied as-is, so replication involves no cryptographic work. The wrapped DEK (`_meta/dek.enc`) reaches the target on the first replication.

::: warning A passphrase compromise reaches every copy
Anyone who has the passphrase can read every target. Limit the damage with separate S3 credentials for each target. Keys for one target do not grant access to another, but they do not protect the data either. Keep the passphrase in a password manager or secrets store with its own backup.
:::

### DEK mismatch

Before the first copy to a target in each run, Atlas checks that the target's key matches the primary's. If a tenant was purged and re-initialized on primary, it has a new DEK. Atlas then refuses to write to a target that still holds objects under the old key:

```
Error: Target has a different encryption key than the source.
Purge the target before replicating from a re-initialized primary.
```

Without this check, the old objects on the target would become permanently unreadable.

### Object Lock is not replicated

Replication copies raw ciphertext without lock metadata. If the target needs immutability, enable Object Lock on that target's bucket separately. See [Immutability](/operations/immutability).

## Replica status

Atlas stores one encrypted status record per snapshot and target in the primary bucket. The layout depends on the workload:

```
atlas-{tenant_id}/
└── _meta/
    └── replication/
        ├── {owner_id}/                            # Outlook
        │   └── {snapshot_id}/
        │       └── {target_id}.json
        ├── onedrive/{owner_id}/                   # OneDrive
        │   └── {snapshot_id}/
        │       └── {target_id}.json
        └── sharepoint/{site_id}/                  # SharePoint
            └── {snapshot_id}/
                └── {target_id}.json
```

Each record holds the target ID, status (`COMPLETED`, `PARTIAL`, or `FAILED`), object and byte counts, timestamps, manifest checksum, and the last error.

```bash
atlas replicate status                          # all snapshots, all targets
atlas replicate status -m user@company.com      # one mailbox
atlas replicate status --site <site-id>         # one SharePoint site
atlas replicate status -s <snapshot-id>         # one snapshot
```

## CLI usage

### Replicate with a target config file

The `--target-config` file holds the target's S3 settings:

```json
{
  "target_id": "offsite-dr",
  "s3_endpoint": "https://offsite.example.com:9000",
  "s3_access_key": "<access-key>",
  "s3_secret_key": "<secret-key>",
  "s3_region": "us-east-1"
}
```

`s3_endpoint`, `s3_access_key`, and `s3_secret_key` are required. `target_id` and `s3_region` are optional. The passphrase comes from your main Atlas configuration, not from this file.

```bash
# One snapshot
atlas replicate -s <snapshot-id> --target-config ./offsite.json

# All unreplicated snapshots for a mailbox
atlas replicate -m user@company.com --target-config ./offsite.json

# A SharePoint site, or one of its snapshots
atlas replicate --site contoso.sharepoint.com,<guid>,<guid> --target-config ./offsite.json
atlas replicate --site contoso.sharepoint.com,<guid>,<guid> -s <snapshot-id> --target-config ./offsite.json

# OneDrive owner
atlas replicate -o user@company.com --target-config ./offsite.json
```

`-m` and `--site` copy only the snapshots the target does not have yet, because Atlas compares manifest lists.

### Pass credentials inline

Use flags instead of a file if you prefer:

```bash
atlas replicate -s <snapshot-id> \
  --target-endpoint https://offsite.example.com:9000 \
  --target-access-key <key> \
  --target-secret-key -
```

`--target-secret-key -` reads the secret from standard input, which keeps it out of shell history and the process list.

SharePoint replication also copies file version indexes and delta cursors alongside the data. Rehydration then restores incremental sync correctly. OneDrive replication copies the same set.

## SDK usage

```typescript
import { createAtlasInstance, createStorageTarget } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({ /* primary config */ });

const offsite = createStorageTarget({
  targetId: 'offsite-dr',
  s3Endpoint: 'https://offsite.example.com:9000',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<same-passphrase-as-primary>',
});

// Replicate one snapshot, or every unreplicated snapshot for a mailbox
const results = await atlas.replicateSnapshot('snapshot-id', [offsite]);
const mailboxResults = await atlas.replicateMailbox('user@company.com', [offsite]);

// OneDrive and SharePoint
await atlas.onedrive.replicateAll('owner-id', [offsite]);
await atlas.onedrive.replicateSnapshot('owner-id', 'od-snap-123', [offsite]);
await atlas.sharepoint.replicateAll('site-id', [offsite]);
await atlas.sharepoint.replicateSnapshot('site-id', 'sp-snap-123', [offsite]);

// Replication status for a snapshot
const status = await atlas.getReplicationStatus('snapshot-id');
```

## Rehydration (disaster recovery)

Rehydration copies data from a target back to primary. It is **not** a sync. It copies only what you ask for, skips snapshots that already exist on primary, and performs no merge or conflict resolution.

::: tip Use rehydration after primary data loss
Run `atlas rehydrate` only to recover from data loss on primary. Afterwards, primary is the source of truth again. Delta links in restored manifests may be stale. Atlas detects this and falls back to a full sync on the next backup.
:::

### Recovery commands

```bash
# One snapshot
atlas rehydrate -s <snapshot-id> \
  --source-endpoint https://offsite.example.com:9000 \
  --source-access-key <key> \
  --source-secret-key -

# All snapshots for a mailbox
atlas rehydrate -m user@company.com --source-config ./offsite.json

# A SharePoint site, or one of its snapshots
atlas rehydrate --site contoso.sharepoint.com,<guid>,<guid> --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,<guid>,<guid> -s <snapshot-id> --source-config ./offsite.json

# Everything: Outlook, OneDrive, and SharePoint
atlas rehydrate --all --source-config ./offsite.json
```

`--all` reads the three manifest roots: `manifests/` (Outlook), `onedrive/manifests/`, and `sharepoint/manifests/`. It reports copied, skipped, and failed counts for each workload. If a workload yields no objects, Atlas names it in a warning, so an incomplete recovery drill cannot pass unnoticed.

### SDK rehydration

```typescript
// One snapshot (Outlook, OneDrive, and SharePoint ids all work)
await atlas.rehydrateSnapshot('snapshot-id', offsite);

// One workload at a time
await atlas.rehydrateMailbox('user@company.com', offsite);
await atlas.onedrive.rehydrateOwner('owner-id', offsite);
await atlas.onedrive.rehydrateSnapshot('owner-id', 'od-snap-123', offsite);
await atlas.sharepoint.rehydrateSite('site-id', offsite);
await atlas.sharepoint.rehydrateSnapshot('site-id', 'sp-snap-123', offsite);

// Full tenant recovery across all workloads
const recovery = await atlas.rehydrateTenant(offsite);
recovery.workloads.forEach((w) => console.log(w.workload, w.result.objectsCopied));
```

## Runbook: recovering from primary failure

1. **Make sure the primary bucket exists** and is reachable, even if it is empty.

2. **Confirm the passphrase.** It must match the one used when the replica was written. Atlas cannot read recovered data with a different passphrase.

3. **Rehydrate every workload:**

   ```bash
   atlas rehydrate --all --source-config ./offsite.json
   ```

4. **Verify the recovered data:**

   ```bash
   atlas outlook list                                          # list recovered mailboxes
   atlas outlook verify -m <mailbox> -s <snapshot-id>          # Outlook integrity
   atlas onedrive verify -o <owner> -s <snapshot-id>           # OneDrive integrity
   atlas sharepoint verify --site <site-url> -s <snapshot-id>  # SharePoint integrity
   ```

5. **Run a fresh backup** to capture changes made after the last replication:

   ```bash
   atlas outlook backup -m <mailbox>
   atlas onedrive backup -o <owner>
   atlas sharepoint backup --site <site-url>
   ```

   Stale delta links are detected automatically, and Atlas falls back to a full sync.

6. **Replicate again** so the target is current:

   ```bash
   atlas replicate -m user@company.com --target-config ./offsite.json
   ```

## See also

- [Storage layout](/operations/storage-layout): the object keys that replication copies
- [Immutability](/operations/immutability): Object Lock on a replica bucket
- [Replication setup](/self-hosting/replication): deployment patterns and scheduling
