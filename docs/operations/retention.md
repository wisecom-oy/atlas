---
description: 'Remove the Outlook, OneDrive, and SharePoint snapshots older than a cut-off and keep every newer one restorable.'
---

# Snapshot retention

`prune` removes one owner's snapshots older than a cut-off and keeps every newer snapshot restorable and verifiable. It works for Outlook mailboxes, OneDrive owners, and SharePoint sites.

```bash
atlas outlook prune -m user@example.com --before 90d --dry-run   # report, change nothing
atlas outlook prune -m user@example.com --before 90d -y
atlas onedrive prune -o user@example.com --before 2026-08-01 -y
atlas sharepoint prune --site https://contoso.sharepoint.com/sites/Engineering --before 12w -y
```

```ts
const result = await atlas.outlook.pruneSnapshots('user@example.com', {
  before: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
});
await atlas.onedrive.pruneSnapshots('user@example.com', { before: '2026-08-01', dryRun: true });
```

The CLI options are in the [CLI reference](/reference/cli#atlas-workload-prune) and the result fields in the [SDK reference](/reference/sdk#pruning-old-snapshots).

## Why pruning needs a baseline

Outlook, OneDrive, and SharePoint snapshots record only what changed in their run. A restore of a snapshot folds it together with every older snapshot of the same owner. Deleting an old snapshot on its own would drop the items it recorded from every later snapshot, which is why [`delete -s`](/reference/cli#atlas-outlook-delete) accepts only the newest one.

A prune first folds the history into the oldest snapshot it keeps, called the baseline. The baseline then holds everything its restore showed before the prune, under its own snapshot ID, so IDs your scripts or SDK host stored stay valid. Only after the baseline is written does the prune delete the older snapshots and the content nothing else references.

## The cut-off

| Snapshot | Outcome |
| --- | --- |
| Created strictly before `--before` | Removed |
| Created at exactly `--before` | Kept, as `delete -s` counts an equal time as newer |
| Created after `--before` | Kept |
| The newest snapshot of the owner | Always kept, even when it is older than the cut-off |

An owner with no snapshot at all is left alone, content included. Remove an owner's data outright with `delete`.

`--before` takes an ISO 8601 date or date-time, such as `2026-08-01` (midnight UTC) or `2026-08-01T00:00:00Z`, or an age counted back from now: `90d`, `12w`, or `36h`. The SDK takes a `Date` or an ISO 8601 string.

When several snapshots share the oldest kept creation time, each of them becomes a baseline. This is rare, because the owner lease keeps two runs of one owner apart.

## Steps and interruption

A prune runs under the [owner lease](/reference/cli#run-leases), like `delete`. It is refused with `ATLAS_OWNER_BUSY` (exit `12`) while a backup, restore, delete, or quarantine of the same owner runs, and a backup is refused while the prune runs. The steps run in this order:

1. **Write the baseline.** The oldest kept snapshot's chain is folded and written over its manifest. For OneDrive and SharePoint, the version index rows of the files the baseline now carries are written to its run index first.
2. **Remove the older snapshots.** Their pointers go first (Outlook), then every version of their manifests, then their rows in the [summary index](/operations/storage-layout#snapshot-summary-index), in one rewrite.
3. **Remove what belonged to them.** Run version indexes and manifest entry parts of every snapshot older than the cut-off whose manifest is gone.
4. **Sweep content.** Every version of every content object that no remaining manifest or version index references is deleted.

Each step leaves a bucket where every kept snapshot restores. Until step 1 lands nothing has changed. After it, the older manifests are redundant: every kept snapshot already finds their contents in the baseline. A process that stops at any point, by a crash, a lost connection, or a cancelled `signal`, leaves a state the next run continues from. The next run folds the same chain into the same baseline, finds it already stored, skips step 1, and finishes the rest. The final bucket is the same as after an uninterrupted run.

## What is removed

| Workload | Removed for each snapshot older than the cut-off | Left alone |
| --- | --- | --- |
| Outlook | Manifest, snapshot pointer, Atlas 6 replication records, summary row | Delta cursor, latest pointer |
| OneDrive, SharePoint | Manifest and its entry parts, run version index, summary row | Delta cursor, legacy per-file version indexes, staging |

Content is removed only when nothing remaining references it: message and legacy attachment blobs for Outlook, file blobs and the historical file versions only a removed run index recorded for OneDrive and SharePoint. A blob shared through deduplication by a removed snapshot and a kept one stays.

Deduplication never crosses owners. Each content object lives under its owner's prefix and its ciphertext is bound to that key, so only the owner's own manifests and indexes can reference it. The reference scan reads the owner's prefixes only, never the whole tenant.

The delta cursor is bound to the newest snapshot, which a prune never removes, so the next backup resumes where it stopped and does not read everything again. File version watermarks live in the cursor too, so versions the removed runs captured are not downloaded again.

## Object Lock

A manifest or object under retention is not deleted. It is reported as retained, not as failed, and a later prune removes it once its retention ends. Atlas never sends `BypassGovernanceRetention`.

A retained old manifest stays in every kept snapshot's chain. The baseline carries a removal record for each message, and a deletion entry for each file, that an older manifest lists and the baseline's restore did not show, so a retained manifest changes nothing a kept snapshot restores. The content a retained manifest references stays with it.

The baseline is written with the Object Lock retention its snapshot was originally written with, until the same retain-until instant. A retention that has already ended is not renewed; the bucket's default retention, if any, applies. The previous version of the baseline's manifest stays as a noncurrent version until a later prune removes that snapshot.

## Damaged and quarantined objects

| Situation | What the prune does |
| --- | --- |
| A manifest of the owner cannot be read | Refuses with `UnreadableObjectsError` (exit `9`) before writing anything |
| The owner has quarantined manifests or version indexes | Removes old snapshots, sweeps no content, reports `quarantined_objects` |
| A version index cannot be read | Removes old snapshots, sweeps no content, reports `unreadable_objects` |

A damaged or quarantined object may reference content nothing else does, so the sweep does not guess. Repair or delete the quarantined copy under `_quarantine/`, then run the prune again.

## Cost of a run

| Resource | Per run |
| --- | --- |
| Manifest reads | The baseline's chain once, then every remaining manifest once, one at a time |
| Version index reads | Every index object of the owner (OneDrive, SharePoint) |
| Listings | The owner's manifest, content, run index, and entry part prefixes, by version, 1,000 per request |
| Writes | At most one manifest and one run index per baseline, and one summary rewrite |
| Deletes | `DeleteObjects` batches of up to 1,000 versions, see [Bulk deletes](/self-hosting/storage#bulk-deletes) |

Memory holds the baseline being folded, about what a restore of that snapshot holds, plus a 96-bit digest per referenced object (roughly 80 bytes each with overhead, so about 80 MB for a million files). Listings and deletes stream a page at a time.

A dry run makes the same reads and listings, takes the owner lease, and writes nothing else. It reports the snapshots, object versions, and bytes the run would remove.

## Effects on other commands

- **Restores and verify.** Every kept snapshot restores and verifies the same content as before. `verify` of a OneDrive or SharePoint baseline finds the version index rows the prune wrote for it.
- **Snapshot lists.** The baseline's row reports the baseline's entries, which include the folded history, so its entry count grows.
- **Mailbox restore by date range.** `restore -m` and `save -m` with `--start-date` merge the snapshots in the range. A range that includes the baseline also includes the messages it carries from before the cut-off.
- **File version history.** `list-versions` no longer offers versions only removed runs captured. A file the baseline carries lists its stored content under the baseline's snapshot ID.
- **Legacy per-file version indexes** (`index/{owner}/files/`) are not pruned. The versions they list stay until the owner is deleted.

## Compatibility

A baseline is an ordinary manifest and has no new fields. Atlas 7.2.x reads an Outlook baseline, and a OneDrive or SharePoint baseline stored as one document. A drive baseline above 32 MiB of entries is stored as a head and entry parts, like any large 7.3.0 manifest, and needs 7.3.0 to read. When the stored manifest is already a head with parts, the baseline replaces it as one document, so the head and its parts never disagree, and the next prune stores it in parts again.

## Scheduling

Run the prune after the owner's backup, not alongside it: both take the owner lease, and the second exits `12`. A scheduled job can treat exit `12` as "retry later".

The prune exits `1` when something was left behind: a retained or failed object, or content it could not sweep. Running it again later removes what retention no longer protects. A dry run exits `0`.

See [Erasure](/security#erasure) for what a prune does and does not erase.
