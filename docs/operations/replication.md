# Replication

Atlas supports snapshot-level replication to one or more secondary S3-compatible storage targets. Replication is a first-class engine feature -- not a wrapper around `mc mirror` or provider-specific tools.

## How Replication Works

```
Primary storage          Replication service          Secondary target(s)
     │                         │                            │
     │  1. Read manifest       │                            │
     │◄────────────────────────│                            │
     │                         │                            │
     │  2. Read data objects   │  3. Write missing objects  │
     │◄────────────────────────│───────────────────────────►│
     │                         │                            │
     │                         │  4. Write manifest (last)  │
     │                         │───────────────────────────►│
     │                         │                            │
     │  5. Write status sidecar│                            │
     │◄────────────────────────│                            │
```

1. The replication service reads the snapshot manifest from primary storage.
2. For each object (messages and attachments) referenced by the manifest, it checks whether the target already has the object.
3. Missing objects are copied as raw ciphertext -- no decryption or re-encryption occurs.
4. The manifest file is always copied last, ensuring a crash never leaves a manifest referencing missing objects.
5. A durable status sidecar is written to primary storage recording the outcome.

Replication is **idempotent**. Running it again for the same snapshot skips all objects that already exist on the target. This makes it safe to retry after failures or interruptions.

## Primary-Is-Truth Principle

::: danger Primary Is Authoritative
Primary storage is always the source of truth during normal operation. Secondary targets receive data only through replication. Never run `atlas outlook backup` directly against a replica target -- Atlas detects the replica marker file and logs a warning if this is attempted.
:::

Replication is one-directional: primary to target. There is no bidirectional sync and no automatic conflict resolution. If you need to recover data from a secondary target (disaster recovery), use `atlas rehydrate` -- a separate, explicit operation described below.

## Shared Encryption Model

Atlas uses a shared encryption model for replication. All targets use the same master passphrase and the same per-tenant Data Encryption Key (DEK). This means:

- Ciphertext is copied byte-for-byte -- no decryption or re-encryption during replication.
- Replication is fast because it only involves object reads and writes, not cryptographic operations.
- The wrapped DEK (`_meta/dek.enc`) is copied to the target on first replication.

::: warning Passphrase Compromise
Because the same passphrase protects all copies, compromising the passphrase compromises data on every target. Mitigate this with separate IAM credentials per storage target -- an attacker who compromises one target's S3 keys cannot reach another target's data, even though the encryption keys are the same.
:::

## DEK Mismatch Protection

Before every replication, Atlas validates that the source and target share the same encryption key. If you purge and re-initialize a tenant on primary (generating a new DEK), Atlas refuses to replicate to a target that still holds objects encrypted with the old key:

```
Error: Target has a different encryption key than the source.
Purge the target before replicating from a re-initialized primary.
```

This prevents silent data corruption where old objects on the target become permanently undecryptable.

## Copy Ordering and Crash Safety

Objects are always copied in this order:

1. **DEK validation** -- verifies source and target share the same encryption key
2. `_meta/dek.enc` -- copied to target if not already present
3. `_meta/replica.marker` -- written on target (skipped during rehydration to primary)
4. Data and attachment objects -- copied in manifest order, skipping objects already on target
5. Ancillary objects (OneDrive and SharePoint) -- file version indexes and delta cursors
6. Manifest file -- **always last**

If replication crashes at any point, the target is left in a safe state: orphan data blobs exist (harmless, reclaimable), but no manifest ever references missing objects. Rerunning replication picks up where it left off.

## Replication Status

Replication status is persisted as encrypted sidecar files in the primary tenant bucket. The path structure varies by workload:

```
atlas-{tenant_id}/
└── _meta/
    └── replication/
        ├── {mailbox_id}/                          # Outlook
        │   └── {snapshot_id}/
        │       └── {target_id}.json
        ├── onedrive/{owner_id}/                   # OneDrive
        │   └── {snapshot_id}/
        │       └── {target_id}.json
        └── sharepoint/{site_id}/                  # SharePoint
            └── {snapshot_id}/
                └── {target_id}.json
```

Each sidecar records: target ID, status (COMPLETED/PARTIAL/FAILED), object counts, byte counts, timestamps, manifest checksums, and the last error. Query status with:

```bash
atlas replicate --status                          # all snapshots, all targets
atlas replicate --status -m user@company.com      # filter by mailbox
atlas replicate --status --site <site-id>         # filter by SharePoint site
atlas replicate --status -s <snapshot-id>         # filter by snapshot
```

## CLI Usage

### Replicate a Snapshot

```bash
atlas replicate -s <snapshot-id> \
  --target-endpoint http://offsite:9000 \
  --target-access-key <key> \
  --target-secret-key <secret>
```

### Replicate All Snapshots for a Mailbox

```bash
atlas replicate -m user@company.com \
  --target-endpoint http://offsite:9000 \
  --target-access-key <key> \
  --target-secret-key <secret>
```

Only unreplicated snapshots are copied (the service diffs manifest lists).

### Replicate OneDrive Snapshots (SDK)

OneDrive per-owner replication is available through the SDK:

```typescript
const offsite = createStorageTarget({ /* ... */ });

// Replicate all unreplicated snapshots for a user
await atlas.onedrive.replicateAll('owner-id', [offsite]);

// Replicate a specific snapshot
await atlas.onedrive.replicateSnapshot('owner-id', 'od-snap-123', [offsite]);
```

OneDrive replication copies data blobs, file version index files, delta cursors, and manifests -- the same ancillary set as SharePoint.

### Replicate SharePoint Site Snapshots

```bash
# Replicate all unreplicated snapshots for a SharePoint site
atlas replicate --site contoso.sharepoint.com,guid,guid --target-config ./offsite.json

# Replicate a specific SharePoint snapshot
atlas replicate --site contoso.sharepoint.com,guid,guid -s sp-snap-123 --target-config ./offsite.json
```

SharePoint replication copies data blobs, file version index files, delta cursors, and manifests. Ancillary objects (indexes + cursors) are replicated alongside data so that incremental sync resumes correctly after rehydration.

### Using a Target Config File

```bash
atlas replicate -s <snapshot-id> --target-config ./offsite.json
```

The file contains S3 credentials for the target:

```json
{
  "target_id": "offsite-dr",
  "s3_endpoint": "http://offsite:9000",
  "s3_access_key": "offsite-key",
  "s3_secret_key": "offsite-secret",
  "s3_region": "us-east-1"
}
```

`target_id` is optional (derived from endpoint if omitted). The encryption passphrase is not in this file -- it comes from the main Atlas configuration (shared model).

## SDK Usage

```typescript
import { createAtlasInstance, createStorageTarget } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({ /* primary config */ });

const offsite = createStorageTarget({
  targetId: 'offsite-dr',
  s3Endpoint: 'http://offsite:9000',
  s3AccessKey: 'offsite-key',
  s3SecretKey: 'offsite-secret',
  encryptionPassphrase: 'same-passphrase-as-primary',
});

// Replicate a snapshot
const results = await atlas.replicateSnapshot('snapshot-id', [offsite]);

// Replicate all unreplicated snapshots for a mailbox
const mailboxResults = await atlas.replicateMailbox('user@company.com', [offsite]);

// Replicate OneDrive snapshots
const odResults = await atlas.onedrive.replicateAll('owner-id', [offsite]);
const odSingle = await atlas.onedrive.replicateSnapshot('owner-id', 'od-snap-123', [offsite]);

// Replicate SharePoint site snapshots
const spResults = await atlas.sharepoint.replicateAll('site-id', [offsite]);
const spSingle = await atlas.sharepoint.replicateSnapshot('site-id', 'sp-snap-123', [offsite]);

// Query replication status
const status = await atlas.getReplicationStatus('snapshot-id');
```

## Rehydration (Disaster Recovery)

Rehydration is a separate, explicit operation for recovering data from a replica to primary. It is **not** a sync -- it copies exactly what the operator specifies.

::: tip Rehydration Is a DR Operation
Use `atlas rehydrate` only when primary storage has suffered data loss. After recovery, primary resumes as the source of truth. Delta links in restored manifests may be stale -- Atlas automatically falls back to full sync on the next backup.
:::

### Three Recovery Modes

**Recover a specific snapshot:**

```bash
atlas rehydrate -s <snapshot-id> \
  --source-endpoint http://offsite:9000 \
  --source-access-key <key> \
  --source-secret-key <secret>
```

**Recover all snapshots for a mailbox:**

```bash
atlas rehydrate -m user@company.com --source-config ./offsite.json
```

**Recover a SharePoint site:**

```bash
atlas rehydrate --site contoso.sharepoint.com,guid,guid --source-config ./offsite.json

# Or a specific SharePoint snapshot
atlas rehydrate --site contoso.sharepoint.com,guid,guid -s sp-snap-123 --source-config ./offsite.json
```

**Full tenant recovery:**

```bash
atlas rehydrate --all --source-config ./offsite.json
```

Rehydration skips snapshots that already exist on primary. It does not merge, diff, or resolve conflicts.

### SDK Rehydration

```typescript
// Recover a single Outlook snapshot
await atlas.rehydrateSnapshot('snapshot-id', offsite);

// Recover a mailbox
await atlas.rehydrateMailbox('user@company.com', offsite);

// Recover a OneDrive user
await atlas.onedrive.rehydrateOwner('owner-id', offsite);
await atlas.onedrive.rehydrateSnapshot('owner-id', 'od-snap-123', offsite);

// Recover a SharePoint site
await atlas.sharepoint.rehydrateSite('site-id', offsite);
await atlas.sharepoint.rehydrateSnapshot('site-id', 'sp-snap-123', offsite);

// Full tenant DR
await atlas.rehydrateTenant(offsite);
```

## Object Lock

Object Lock policies are **not** replicated per-object. If you want immutable backups on a secondary target, configure Object Lock at the bucket level on that target independently. The replication service copies raw ciphertext without lock metadata.

## Operational Runbook: Recovering from Primary Failure

If primary storage fails and you need to restore from a replica:

1. **Ensure primary bucket exists** and is accessible (even if empty).

2. **Verify the passphrase** is the same one used when the replica was created.

3. **Run full tenant rehydration:**
   ```bash
   atlas rehydrate --all --source-config ./offsite.json
   ```

4. **Verify recovered data:**
   ```bash
   atlas outlook list                       # check recovered mailboxes
   atlas outlook verify -m <mailbox> -s <snapshot-id>  # verify Outlook integrity
   atlas onedrive verify -o <owner> -s <snapshot-id>   # verify OneDrive integrity
   atlas sharepoint verify --site <site-url> -s <snapshot-id>  # verify SharePoint integrity
   ```

5. **Run a fresh backup** to capture any changes since the last replication:
   ```bash
   atlas outlook backup
   atlas onedrive backup -o <owner>
   atlas sharepoint backup --site <site-url>
   ```
   Stale delta links are handled automatically -- Atlas falls back to full sync.

6. **Re-replicate** to ensure the secondary target is current:
   ```bash
   atlas replicate -m user@company.com --target-config ./offsite.json
   ```
