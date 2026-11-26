---
description: How Atlas backs up only what changed since the last run, when it reads everything again, and what each case costs.
---

# Incremental backup (delta sync)

The first backup of a mailbox, drive, or site reads everything. Every later backup reads only the messages and files that were created, changed, or deleted since the previous run. A nightly run therefore costs a small share of the Microsoft 365 requests, bandwidth, and time of the first one.

```bash
atlas outlook backup -m user@example.com -s "$TENANT"          # incremental, from the saved sync checkpoints
atlas outlook backup -m user@example.com -s "$TENANT" --full   # ignore the checkpoints and read everything
```

## How incremental backup works

At the end of each run, Atlas saves a sync checkpoint (a Microsoft Graph [delta link](https://learn.microsoft.com/en-us/graph/delta-query-messages)) for every mail folder, drive, library, or calendar it finished. The next run sends the checkpoint back, and Microsoft 365 returns only the changes after it.

A checkpoint is a Microsoft Graph URL that carries an opaque sync token:

```
https://graph.microsoft.com/v1.0/users/.../messages/delta?$deltatoken=aGR2b...
```

Checkpoints are kept in the owner's delta cursor object, for example `_meta/outlook-cursors/{owner_id}.json` for a mailbox. Outlook also stores them in each snapshot manifest. See [Storage layout](/operations/storage-layout) for every workload's path.

::: warning Checkpoints are sensitive
A checkpoint holds tenant-scoped sync state. Anyone who obtains one could learn which items in the mailbox changed. Atlas stores checkpoints only inside cursors and manifests encrypted with the tenant data key, never in plaintext. Do not copy them into logs or tickets.
:::

::: details First run and later runs (Outlook)
1. **First run.** For each folder, Atlas requests `/users/{id}/mailFolders/{id}/messages/delta`, including the message body. Microsoft Graph pages through every message. The final `@odata.deltaLink` is saved in the mailbox's cursor, `_meta/outlook-cursors/{owner_id}.json`, and in the snapshot manifest when the run writes one.
2. **Later runs.** Atlas sends the saved link, and Microsoft Graph returns only the changes since the last sync.
:::

## When Atlas reads everything again {#when-atlas-performs-a-full-enumeration}

Atlas falls back to a full backup of a folder, drive, or library whenever its checkpoint can no longer be trusted. You never need to detect these cases yourself.

| Situation | What Atlas does |
| --- | --- |
| You pass `--full` | Ignores every saved checkpoint. Use it for a periodic audit, or when you suspect a checkpoint is damaged |
| The checkpoint expired or was rejected | Microsoft Graph returns `syncStateNotFound`, `resyncRequired`, or `syncStateInvalid`. Atlas reads the folder in full and logs a warning |
| The previous run stored nothing (stale-delta safeguard) | A saved Outlook checkpoint returns no items, but the previous manifest has no entries, so the earlier run was interrupted before it stored anything. Atlas discards the checkpoint and reads the folder in full |
| The snapshot the checkpoint belongs to is gone | The snapshot was deleted or quarantined, or the whole backup of the owner was removed. Resuming would skip every change it held, so Atlas reads every folder, drive, or library in full |
| First backup of a mailbox whose snapshots use mutable message IDs | Mixing ID formats breaks correlation, so this one run is full and records `id_format: immutable` in its manifest. It happens once per mailbox. See [Immutable message IDs](#immutable-message-ids) |

Checkpoints expire after a period of inactivity, which breaks the incremental chain. When Outlook rejects a checkpoint after some of its pages were already stored, the full read skips those messages and keeps the removals they carried.

A full read is scoped to the folder, drive, or library that triggered it. Checkpoints are kept per drive, so a site with several libraries, or a user with several drives, keeps working checkpoints for the rest. Files in the drive read in full are recorded again as `created`. Files elsewhere keep their history, and an edit there is still reported as `updated`.

### Deletions found by a full read (OneDrive and SharePoint) {#drive-full-read-deletions}

A full listing names the files that exist, not the ones removed since the last run. After a full read of a drive or library, Atlas compares the listing with the earlier snapshots and records a deletion for each file they list that the listing no longer returns. Without that entry, a point-in-time restore of the new snapshot would bring the deleted file back.

The comparison is only sound when the listing is complete. Microsoft Graph marks the end of a delta listing by putting `@odata.deltaLink` (the next checkpoint) on its last page, and every page before it carries `@odata.nextLink`. A page with neither link means the listing stopped early, and a file missing from it may still exist. Atlas then fails that drive or library:

- No entries and no deletions are recorded for it, so a snapshot never marks a live file as deleted.
- It keeps the checkpoint the run started from, and the next run reads the same changes again. A run started by `--full`, a changed `--folder`, or a deleted snapshot has no checkpoint to keep, so the next run reads that drive in full again.
- The other drives and libraries continue, and the command exits `2`.

The same rule covers an interrupted run: a drive whose listing or processing did not finish records no deletions.

::: details How a checkpoint is matched to its snapshot
**Outlook, Contacts, and Calendar** cursors record the snapshot that was newest when they were saved. When that snapshot is no longer the newest readable manifest, Atlas ignores the checkpoints and reads every folder in full.

**OneDrive and SharePoint** cursors record the snapshot they were saved with: the one the run wrote, or the newest one when the run changed nothing. A backup resumes the cursor only while that snapshot's manifest still exists. The check is one listing of the manifest prefix and does not read the manifests, because a drive has no pointer to its newest one. Once the manifest is gone, the run reads every drive or library in full, records a deletion for each file the remaining snapshots list that no longer exists, rebuilds the [version watermarks](#file-version-capture-onedrive-and-sharepoint) from the version index, and warns. An owner or site with no snapshot at all, such as an empty drive, records that, and its cursor is resumed until a manifest appears.

Cursors written before 7.0 record no snapshot. They are trusted while any manifest exists, until the next backup rewrites them.
:::

### What a full backup costs {#what-a-full-run-costs}

A full run, whether you asked for it with `--full` or Atlas fell back to one, costs what a first backup costs in Microsoft 365 requests and time. For Outlook, Microsoft Graph lists every message again at one delta page per 10 messages by default (`--page-size`), and Atlas fetches each message's MIME with one `/$value` request plus one reaction `$batch` per page. The content must be read before it can be hashed.

Storage barely grows. Each unique message or file is stored once, so content already in the bucket costs one `HEAD` request and no upload. The run always writes a snapshot, and for Outlook that manifest lists every message of the selected folders, so it is as large as the first backup's.

A full read records no deletions for Outlook, because Microsoft 365 reports what exists, not what was deleted. See [Deleted and moved messages](#deleted-and-moved-messages-outlook).

### After a snapshot delete

`delete -s` also deletes the owner's delta cursor. What the next backup reads depends on the workload:

| Workload | Next backup after `delete -s` |
| --- | --- |
| Calendar, Contacts | Reads every calendar or folder in full, whichever snapshot was deleted. Each manifest is complete, so deleting an older snapshot loses nothing |
| Outlook | Resumes from the checkpoints in the remaining newest snapshot, so it reads only the changes since that snapshot, including those the deleted one held. Only the newest snapshot can be deleted, so those checkpoints are always the right base |
| OneDrive, SharePoint | Reads every drive or library in full. Only the newest snapshot can be deleted, because newer ones are built on it. Every existing file gets an entry in the new snapshot, stored content is not uploaded again, and files the remaining snapshots list that are gone are recorded as deleted. See [`delete -s`](/reference/cli#drive-snapshot-delete) |

`delete -m`, and `delete` without `-s` on OneDrive and SharePoint, remove the cursor with the rest of the owner's data, so the next backup is a full backup on every workload.

## Deleted and moved messages (Outlook)

```bash
atlas outlook backup -m user@example.com          # records messages deleted since the last run
atlas outlook restore -s <snapshot-id> -T user@example.com
```

An Outlook snapshot holds only the messages its run stored. `restore -s`, `save -s`, and `verify -s` therefore read the snapshot together with every older snapshot of the mailbox.

Microsoft 365 also reports messages deleted from, or moved out of, each folder. Atlas records them in the manifest as `removed_object_ids`, and a removal hides that message in every older snapshot of the chain. A message deleted before a snapshot is therefore not restored, saved, or verified from it. A run whose only change is a deletion still writes a snapshot, because the removal exists nowhere else once the checkpoint moves past it.

A moved message keeps its ID, because Atlas uses [immutable message IDs](#immutable-message-ids). Microsoft 365 reports the move as a removal from the old folder and a new message in the new one. A manifest's own entries win over its own removals, so the message stays restorable at its new location.

### When removals are recorded

Removals are only safe when the run saw both ends of a move. Atlas records them only when every selected folder finished:

| Run | Removals | Checkpoints |
| --- | --- | --- |
| Every selected folder finished, no `--folder`, no folder that can receive mail excluded | Recorded | Advance |
| Interrupted, or a folder failed | None | Every folder that reported a removal keeps its previous checkpoint, so the next complete run fetches and records the removals |
| A folder was deleted while the run listed folders | None. The folder is skipped with a warning and recorded as `deleted-during-listing`, including Recoverable Items subfolders, because mail may have moved into it | The vanished folder keeps its previous checkpoint and stored messages. The next run no longer lists it and records removals as usual |
| `--folder` or `--exclude-junk` | None, and the removals it saw are dropped | Advance anyway, because a mailbox always backed up this way would otherwise never move forward |

Excluding hidden system folders such as `Conversation Action Settings`, or the non-mail Recoverable Items subfolders, does not block removals, because mail cannot be moved into them. An unrecognised Recoverable Items subfolder does block them, because Atlas cannot tell what it holds.

A message moved into Junk Email during a run that records no removals therefore stays restorable from its last captured copy instead of disappearing from the chain. Messages fetched again after a withheld checkpoint deduplicate against the objects already stored.

::: warning Fix a folder that fails on every run
A folder that fails on every run holds back the checkpoints of every folder with pending removals until it succeeds. Removals stay unrecorded until then, so fix a persistent folder error rather than leaving it.
:::

### Deletions that are never recorded

These deleted messages still come back from the chain:

| Case | Why |
| --- | --- |
| A filtered or excluded run | `--folder` or `--exclude-junk`. Checkpoints advance, so the removals it saw are not reported again |
| A full read | `--full`, an expired checkpoint, or the stale-delta safeguard reads the folder again. Microsoft 365 reports what exists, not what was deleted. Removals read before Microsoft Graph rejected an expired checkpoint are still recorded |
| Snapshots written before Atlas recorded removals | The field is absent, so nothing is hidden |

## Commit order for OneDrive and SharePoint

A OneDrive or SharePoint run writes three objects, always in this order:

1. The snapshot manifest, if the run produced entries.
2. The run's version index.
3. The cursor with the new checkpoints.

A run with no entries skips step 1. Outlook follows the same rule: the manifest first, then the cursor. An Outlook run that captured nothing and found no deletions writes only the cursor.

This order makes a failed run safe to rerun. The checkpoint never moves past content that no snapshot references, which would let the next run report success while that content stayed unreachable. The worst case is repeated work: a crash after the manifest but before the cursor makes the next run read the same interval again and write a second snapshot. Content already stored deduplicates, so it costs only Microsoft 365 reads.

A run covering several drives or libraries commits all their checkpoints together, after the manifest. A finished drive never has its progress saved ahead of the snapshot that references it.

## File version capture (OneDrive and SharePoint)

OneDrive and SharePoint backups keep earlier versions of each file as well as the current copy. For every file reported as changed whose content was not already stored, and for every file whose earlier version capture did not finish, Atlas lists its versions with `GET /drives/{drive-id}/items/{item-id}/versions` and stores each version it has not captured yet. The current version is skipped, because the snapshot entry already holds it.

Atlas keeps a watermark per file in the cursor, so it knows which versions it already holds without downloading them. Versions are processed oldest first, and the watermark stops at the first version the run could not capture:

| Outcome for a version | Watermark | Next run |
| --- | --- | --- |
| Stored, or already stored as a deduplicated object | Advances past it | Skips it |
| `404` or `410`, and the version has left the file's version list | Advances past it | Skips it. The library's version policy removed it and it can never be retrieved |
| `404` or `410`, and the version is still listed | Stops before it, until the answer repeats on 3 runs in a row spanning at least 24 hours | Retries it and every newer version |
| Any other error, such as `403` or `500` | Stops before it | Retries it and every newer version |

A file with a failed version, or whose capture was cut short after its content was stored, is kept in the cursor's `pending_versions_by_file_id` map, with the `404` streak of each still-listed version. Content that is already stored does not mean the change was fully processed, so the next run that sees a pending file lists its versions again even when the content deduplicates. A file leaves the map when a capture finishes with no failed version, or when it is deleted.

Nothing is dropped silently. A version with a missing or unparseable `lastModifiedDateTime` is never treated as captured: Atlas fetches it again when the file changes, and deduplication prevents a second stored copy.

Steady-state backups read only the cursor, which they read anyway, and do not read the version index.

::: details Watermark format
```json
{
  "owner_id": "2f1c9a04-7b3d-4e11-9c2a-6d5e8f0a1b2c",
  "delta_link_by_drive": { "b!x9Kp...": "https://graph.microsoft.com/v1.0/..." },
  "version_watermark_by_file_id": {
    "01ABCDEF...": {
      "last_modified_at": "2026-08-24T09:12:44Z",
      "version_ids": ["7.0", "8.0"]
    }
  }
}
```

- `last_modified_at` skips every version older than the timestamp.
- `version_ids` skips only the versions already captured at exactly that timestamp.

Microsoft Graph reports `lastModifiedDateTime` to the second, so two versions can share a timestamp. A timestamp alone could skip a version created later in the same second, so Atlas also keeps the IDs captured at the newest timestamp and drops older IDs. Version IDs are compared for equality only. Atlas never parses or sorts them, because Microsoft Graph does not guarantee their format or order.

A watermark stores one timestamp and the IDs at that timestamp, not the full history.
:::

### `--full`, and cursors without watermarks {#upgrades-and-full}

`--full` does not reset watermarks. It reads every file again, but the version history Atlas already holds stays valid. To fetch the version history again on purpose, delete the version index and the cursor for that owner or site.

A cursor written before watermarks existed has no watermark map. The first run that reads it rebuilds the map from the version index, logs `Seeding version dedup watermarks`, and writes exact state to the cursor. A cursor with timestamp-only values upgrades each file when that file next changes, and versions that share the timestamp are captured once more during the conversion.

## Immutable message IDs

Atlas sends `Prefer: IdType="ImmutableId"` on every Outlook request: delta pages, message reads, and attachment fetches. With immutable IDs a message moved between folders keeps its identity, so only its changed folder metadata is stored again.

The default Outlook ID changes when a message moves. A move into an archive folder would then look like a deletion and a new message: Atlas would download content it already holds, and older snapshot entries would point at IDs Microsoft 365 no longer resolves. Microsoft requires the header on every request that handles an ID, because mixing the two formats breaks correlation.

Immutable IDs are stable within one mailbox, not across mailboxes. They also change when an item moves into an In-Place Archive or is exported and imported again. See [Obtain immutable identifiers for Outlook resources](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

## Original MIME retrieval

For each new or changed message, Atlas stores the original **RFC 5322 MIME** bytes as the message's encrypted object:

```
GET /users/{id}/messages/{id}/$value
```

The original bytes keep what the JSON form of a message does not expose: the `Received:` chain, `Authentication-Results` (DKIM, SPF, and ARC), `In-Reply-To` and `References` threading, and S/MIME payloads. See [Backup fidelity](/security#backup-fidelity).

MIME is the only format for new snapshots. There is no `--fidelity` option.

### Request cost

| Message | Requests beyond the delta page |
| --- | --- |
| No attachments | One `/$value` request |
| With attachments | One `/$value` request. Attachments are inside the MIME and cost nothing extra |

Incremental runs fetch MIME only for new and changed messages. The first backup of a large mailbox is the expensive case, and the [retry policy](/operations/reliability#microsoft-graph-requests) absorbs the throttling it causes.

### When a message cannot be stored as MIME

| Situation | What Atlas does |
| --- | --- |
| Exchange refuses the conversion for good with `500 ErrorMimeContentConversionFailed` | Sends the request once, without retries. Stores the JSON form, records the error code as `mime_unavailable` in the snapshot entry, reports it as an error of its folder, and exits `2`. This failure alone does not hold the folder's checkpoint back, so the next run does not ask for the MIME again unless the message changes or another failure in the folder withholds the checkpoint |
| The MIME request still fails after [retries](/operations/reliability#microsoft-graph-requests), for example a `503` | Stores the JSON form so the message is kept, reports it as an error of its folder, keeps the folder's previous checkpoint, and exits `2`. The next run fetches the folder's changes again, captures the MIME, and its entry replaces the JSON one |
| The MIME request answers `400`, `401`, or `404` | Handled as the failed request above. These answers are not retried, and none of them proves that Microsoft 365 has no MIME for the message, so the next run asks again |
| The message was deleted after its delta page was read, so the MIME request answers `404` | Handled as the failed request above, for one run only. The next run's changes report the message as removed rather than listing it, so its MIME is not requested again and the folder's checkpoint moves on |
| The MIME request answers `403` | Fails the folder with an error naming the Microsoft Graph permissions to grant. The folder keeps its previous checkpoint. A missing permission would fail every message, so it is never stored as JSON one message at a time |
| The MIME request answers `200` with an empty body on all 3 attempts | Handled as the failed request above. Zero bytes are never stored as MIME, so the empty answer cannot replace the message's content in the snapshot |
| A JSON entry's attachments could not be fetched or stored | Handled the same way: the next run fetches the message and its attachments again |

Entries with `payload_format: "mime"` hold original bytes. Entries without the field hold legacy JSON. A snapshot can mix both, and `save`, `read`, `restore`, and `verify` handle both. A message that fails on every run holds its folder's checkpoint back until it succeeds, and the changes fetched again each time deduplicate against the stored objects. `ErrorMimeContentConversionFailed` is the exception: Exchange returns it with a `500` status, yet the same item fails the same way days later, so retrying it only re-read the folder on every run. Old meeting responses with attachments are a known cause.

### Reactions, flag, and pin

Atlas captures each message's follow-up flag, Outlook reactions (like, heart, celebrate, and so on), and pin, and stores them in the message's snapshot entry:

| Property | Snapshot entry field | Stored when |
| --- | --- | --- |
| Follow-up flag status, with start, due, and completed dates | `flag` | The message is flagged. A MIME entry needs it because MIME carries at most an `X-Message-Flag` header |
| Reactions | `reaction_properties` | The message has reactions |
| Pin | `pin_properties` | The pin property `0x0F01` is present, which it is not on a message that was never pinned |

Adding a reaction or a flag updates the message's `lastModifiedDateTime`, so the next incremental run picks it up as a changed message.

The flag arrives with the delta page. Reactions and the pin need one extra read per message:

- A throttled or failed read is retried for that message alone.
- A read that still fails backs the message up without its reactions and pin. The run summary prints a warning per folder with the count. The checkpoint moves on, so those properties are read again only when the message next changes. The flag is not affected.
- A permission or licensing failure stops the mailbox, as it does for MIME.
- If the configured mailbox connector cannot read these properties at all, Atlas logs that once and captures none.

::: details How reactions and the pin are read
Reactions and the pin live in MAPI properties, not in the MIME and not in the delta payload. Outlook pins a message by setting its renew times, `SystemTime 0x0F02` and `SystemTime 0x0F01`, to a far-future date. Microsoft Graph rejects the `$expand` that would read them on the delta query with `400 BadRequest`, so Atlas reads them for each delta page in one `$batch` of up to 20 requests:

```
GET /users/{id}/messages/{id}?$select=id&$expand=singleValueExtendedProperties($filter=...)
```

The requests in a batch are chained with `dependsOn`, so Exchange runs them one at a time and the batch never exceeds the four concurrent requests a mailbox allows. Every message still counts once against the per-mailbox budget, because Microsoft Graph evaluates each request in a batch on its own. The batch saves round trips: at the default page size of 10, a first backup of N messages makes N `/$value` requests plus N/10 batch round trips. At `--page-size 100` it is N/20.

Every message in a page is read, including messages without reactions and messages whose content deduplicates, because reactions and the pin belong to the snapshot entry rather than to the stored object.
:::

## Retry and error handling

Atlas retries `429 Too Many Requests` (honouring `Retry-After`) and `500`, `502`, `503`, `504` on its own, up to 12 times. `501` and every other `4xx` are not retried, because the same request returns the same error. [Retries and fail-safes](/operations/reliability#microsoft-graph-requests) lists every parameter. For incremental backup, these outcomes matter:

| Response | Effect on the checkpoint |
| --- | --- |
| `syncStateNotFound`, `resyncRequired`, `syncStateInvalid` | The checkpoint is no longer valid. Atlas reads the folder in full |
| Retries exhausted on a folder | Atlas marks the folder as failed and continues with the remaining folders. The failed folder keeps its previous checkpoint |
| A drive or library's last delta page carries neither `@odata.nextLink` nor `@odata.deltaLink` | The listing stopped early. Atlas fails that drive or library, which keeps its previous checkpoint and records no deletions. See [Deletions found by a full read](#drive-full-read-deletions) |
| An Outlook folder's last delta page carries neither `@odata.nextLink` nor `@odata.deltaLink` | The read stopped early, so messages on the pages never requested are missing. Atlas fails that folder, which keeps its previous checkpoint, and the run records no removals and exits `2`. The next run reads the folder again |

## Stopping a run {#interruption}

| Action | Effect on checkpoints |
| --- | --- |
| First Ctrl+C | Completed folders and their checkpoints are saved to a partial manifest, and the command exits `2`. The dashboard marks interrupted folders. The next run resumes from those checkpoints, and an interrupted folder is read again from its previous one |
| Second Ctrl+C | Exits at once with `130`. No manifest is written, so no checkpoint moves. Objects already uploaded stay in storage and deduplicate on the next run. The [lease](/reference/sdk#concurrent-operations) is not released, so a backup of the same mailbox started within 10 minutes exits `12` |

A partial manifest from the first Ctrl+C is a valid snapshot. Microsoft Graph has no cancel, so a request it already accepted still completes on its side, and Atlas drops the result. [Ctrl+C and signals](/operations/reliability#ctrl-c-and-signals) covers the other commands.

## See also

- [Retries and fail-safes](/operations/reliability): commit order, leases, and partial runs across every workload
- [Graph rate limits](/operations/graph-rate-limits): the request budgets incremental backup draws on
- [Storage layout](/operations/storage-layout): where manifests, cursors, and version indexes are stored
- [Immutability](/operations/immutability): retention for stored versions
