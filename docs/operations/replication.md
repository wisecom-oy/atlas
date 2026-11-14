---
description: Copy completed Atlas snapshots from your primary bucket to secondary S3-compatible targets with atlas replicate, including safety rules and disaster recovery.
---

# Replication

Replication copies completed snapshots from your primary bucket to one or more secondary S3-compatible targets. It is built into Atlas and needs no external sync tool.

```bash
atlas replicate -s <snapshot-id> --target-config ./offsite.json
```

## How replication works

### What a snapshot holds

An Outlook, OneDrive, or SharePoint manifest records only the changes of the run that wrote it. A snapshot is that manifest folded together with every older manifest of the same mailbox, drive owner, or site, which is how `verify`, `save`, and `restore` read it. A manifest carries no reference to the one before it, so a copy that holds the newest manifest without the older ones restores less than the original, and `verify` cannot tell.

Contacts and calendar manifests are different: each one lists every contact or event of the mailbox, so a contacts or calendar snapshot is whole on its own. Replication copies each one as a chain of one manifest. A failed contacts or calendar snapshot holds back no newer one, and a rerun retries only the snapshots the target still lacks.

Replication therefore always works on whole chains:

| Command                           | Copies                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `replicate -s <id>`               | The named snapshot and every older snapshot of its mailbox, drive owner, or site that the target lacks |
| `replicate -m`                    | Every Outlook, contacts, and calendar snapshot of that mailbox that the target lacks                   |
| `replicate -o`, `--site`          | Every snapshot of that drive owner or site that the target lacks                                       |
| `rehydrate -s <id>`               | The named snapshot and every older snapshot of its owner on the replica that primary lacks             |
| `rehydrate -m`                    | Every Outlook, contacts, and calendar snapshot of that mailbox that primary lacks                      |
| `rehydrate -o`, `--site`, `--all` | Every snapshot in scope that primary lacks                                                             |

Snapshots are copied oldest first. When older and newer snapshots share a creation time, the one you named is copied last. Before copying any snapshot, `-s` reads the whole chain on the side it copies from. If a manifest the chain needs cannot be decrypted, or was removed after Atlas listed it, the command fails before any snapshot object or manifest is written and names those keys, the same refusal `verify` gives. Quarantine the damaged manifest, or replicate by mailbox, owner, or site instead.

`rehydrate -s` installs the replica's encryption key on primary before it reads the chain, for Outlook, OneDrive, and SharePoint alike. A refused rehydration can therefore leave that key on a primary that had none. That is the key every rehydration from this replica needs, and a later run accepts it (see [atlas rehydrate](/reference/cli#atlas-rehydrate)).

### Copying one snapshot

For each snapshot it copies, Atlas:

1. Reads the snapshot manifest from primary storage.
2. Checks which of the manifest's objects (messages, attachments, contacts and their photos, events and their attachments, and file data) the target already holds.
3. Copies the missing objects as raw ciphertext. Nothing is decrypted or re-encrypted. Each object is read from primary once and streamed to the target, so memory stays bounded however large the object is (see [Bandwidth](/self-hosting/replication#bandwidth)).
4. Copies the manifest **last**, so a target never holds a manifest that points at missing objects.
5. Writes a status record to primary storage with the outcome.

Replication is **idempotent**. Running it again skips snapshots whose manifest the target already has and objects it already holds, so retrying after a failure or interruption is safe. A manifest already on the target is never written again. On a versioned or Object Lock bucket every write adds a version that cannot be removed early, so this keeps reruns from piling up locked copies.

### Copy order and crash safety

| Step | Object                                      | Notes                                                                               |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | DEK validation                              | Passes when the target has no key yet. Refuses before any write if the key differs. |
| 2    | `_meta/dek.enc`                             | Copied to the target if absent.                                                     |
| 3    | `_meta/replica.marker`                      | Written to the target. Rehydration to primary skips it.                             |
| 4    | Data and attachment objects                 | Copied in manifest order, skipping objects already present.                         |
| 5    | Ancillary objects (OneDrive and SharePoint) | File version indexes and delta cursors.                                             |
| 6    | Manifest                                    | **Always last.**                                                                    |

If replication stops at any point, the target holds some orphan data objects, which are harmless and can be reclaimed. No manifest references a missing object. The next run resumes where the last one stopped.

A run that finishes with failures follows the same rule. If any object fails to copy, Atlas does not write the manifest. The snapshot remains unreplicated, and the next run retries it. Every run decides which snapshots need copying by checking for their manifests on the target. A manifest written after a partial copy would make the gap permanent: later runs would report nothing to do while objects stayed missing.

A failed snapshot also stops its owner's chain. No newer snapshot of that mailbox, drive owner, or site is written in the same run, because it would read as complete while missing everything the failed one recorded. The failed snapshot's result names the snapshots left out, and the command reports a failure. Other owners in the same run carry on. A run never adds a gap to a chain, and the next run resumes at the gap it stopped at.

A gap that predates the run stays open until a run copies the missing links. A target can already hold a newer manifest whose older links are missing, written by `replicate -s` before it copied whole chains or by an older run that continued past a failure. A failed copy of a missing older link leaves that newer manifest in place, so the chain on the target stays incomplete. Rerun until the run reports no failures before you rely on the replica.

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

# All unreplicated Outlook, contacts, and calendar snapshots for a mailbox
atlas replicate -m user@company.com --target-config ./offsite.json

# A SharePoint site, or one of its snapshots
atlas replicate --site contoso.sharepoint.com,<guid>,<guid> --target-config ./offsite.json
atlas replicate --site contoso.sharepoint.com,<guid>,<guid> -s <snapshot-id> --target-config ./offsite.json

# OneDrive owner
atlas replicate -o user@company.com --target-config ./offsite.json
```

Every form copies only the snapshots the target does not have yet. `-m` covers the mailbox's Outlook, contacts, and calendar snapshots in one run and holds the mailbox's lease for all three workloads, so a contacts or calendar backup of that mailbox is refused with `OwnerBusyError` while it runs. Contacts and calendar snapshots are copied by mailbox or tenant only: `-s` with a `ct-snap-*` or `cal-snap-*` ID is refused and names `-m` instead. A contacts or calendar manifest that cannot be decrypted on primary is reported as a failed snapshot, the other snapshots are still copied, and the command exits `1`. `-s` also brings the older snapshots its chain needs, so the first `-s` of a mailbox to an empty target copies the mailbox's history up to that snapshot. Each copied snapshot gets its own status record.

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

const atlas = createAtlasInstance({/* primary config */});

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

Rehydration copies data from a target back to primary. It is **not** a sync. It copies only what you ask for, skips snapshots that already exist on primary, and performs no merge or conflict resolution. Like replication, `rehydrate -s` brings the older snapshots of the owner that primary lacks, oldest first, and stops at the first one that fails.

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

# All Outlook, contacts, and calendar snapshots for a mailbox
atlas rehydrate -m user@company.com --source-config ./offsite.json

# A SharePoint site, or one of its snapshots
atlas rehydrate --site contoso.sharepoint.com,<guid>,<guid> --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,<guid>,<guid> -s <snapshot-id> --source-config ./offsite.json

# Everything except Teams: Outlook, contacts, calendar, OneDrive, and SharePoint
atlas rehydrate --all --source-config ./offsite.json
```

`--all` reads the five manifest roots: `manifests/` (Outlook), `contacts/manifests/`, `calendar/manifests/`, `onedrive/manifests/`, and `sharepoint/manifests/`. It reports copied, skipped, and failed counts for each workload. If a workload yields no objects, Atlas names it in a warning, so an incomplete recovery drill cannot pass unnoticed. `-m` reports Outlook, contacts, and calendar together as one result.

Contacts and calendar recovery copies snapshot manifests and the objects they name. It does not copy the per-mailbox delta cursor or snapshot summary index under `contacts/_meta/` and `calendar/_meta/`. Listing rebuilds the summary from the manifests, and the first contacts or calendar backup after a recovery enumerates the mailbox in full, as Outlook does.

Teams is not replicated yet. Passing a `teams-snap-*` ID to replication or rehydration fails with `Teams snapshots are not replicated yet`, and tenant recovery names Teams as not covered. That warning does not change the exit code: a replica written by `atlas replicate` never holds Teams data, so nothing on it is left behind. Any failed object in any workload exits `1`.

### SDK rehydration

```typescript
// One snapshot (Outlook, OneDrive, and SharePoint ids work; contacts and calendar go by mailbox)
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
