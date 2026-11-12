---
description: How Atlas uses Microsoft Graph delta queries for incremental backups, when to pass --full, and how saved delta links cut bandwidth and run time.
---

# Delta sync

Atlas uses Microsoft Graph [delta queries](https://learn.microsoft.com/en-us/graph/delta-query-messages) for incremental backups. The first backup reads everything. Later backups fetch only the messages and files that were created, changed, or deleted since the previous run. This reduces bandwidth, Graph requests, and run time.

```bash
atlas outlook backup -m user@example.com -s "$TENANT"          # incremental, uses the saved delta links
atlas outlook backup -m user@example.com -s "$TENANT" --full   # ignore saved delta links
```

## Lifecycle of a delta link

1. **First run.** Atlas requests `/users/{id}/mailFolders/{id}/messages/delta` for each folder, including the message body. Graph pages through every message. The final `@odata.deltaLink` is saved in the mailbox's delta cursor, `_meta/outlook-cursors/{owner_id}.json`, and in the snapshot manifest when the run writes one.
2. **Later runs.** Atlas sends the saved link. Graph returns only the changes since the last sync.

A delta link is a Graph URL with an opaque sync token:

```
https://graph.microsoft.com/v1.0/users/.../messages/delta?$deltatoken=aGR2b...
```

The token records the point where the last sync ended. Sending the link back returns only the changes after that point.

::: warning Delta links are sensitive
Delta links are stored inside encrypted cursor objects, and for Outlook also inside the encrypted manifest, never in plaintext. They hold tenant-scoped sync state. Anyone who obtains one could learn which mailbox items changed. Atlas encrypts manifests and cursors with the tenant data key, so the links are protected at rest. Do not copy them into logs or tickets.
:::

## When Atlas performs a full enumeration

| Trigger                  | Behaviour                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale-delta safeguard    | The saved link returns no items, but the previous manifest stored no entries. The earlier backup was interrupted before storing anything, so Atlas discards the link and enumerates the folder in full.                                                                                                                                                       |
| Expired or invalid token | Graph returns `syncStateNotFound`, `resyncRequired`, or `syncStateInvalid`. Atlas resyncs the folder in full and logs a warning. Tokens lapse after a period of inactivity, and the incremental chain is broken. Outlook can reject a token after some of its pages were already stored; the resync skips those messages and keeps the removals they carried. |
| `--full`                 | `atlas outlook backup --full` ignores every saved link. Use it for periodic audits, or when you suspect a link is corrupt. See [what a full run costs](/troubleshooting#outlook-cursor-carries-folder-links-of-another-mailbox).                                                                                                                              |
| Cursor outlived its snapshot | Outlook, Contacts, and Calendar cursors record the snapshot that was newest when they were saved. When that snapshot is no longer the newest readable manifest, because it was deleted, quarantined, or the whole mailbox backup was removed, the links would skip every change it held. Atlas ignores them and reads every folder in full. Cursors written before 7.0 record no snapshot and are trusted while any manifest exists, until the next backup rewrites them. |
| Drive cursor outlived its snapshot | OneDrive and SharePoint cursors record the snapshot they were saved with: the one the run wrote, or the newest one when the run changed nothing. A backup resumes the cursor only while that snapshot's manifest still exists. Once it was deleted or quarantined, the run reads every drive or library in full, records a deletion for each file the remaining snapshots list that is gone, rebuilds the version watermarks from the version index, and warns. The check is one listing of the manifest prefix. It does not read the manifests, because a drive has no pointer to its newest one. A cursor of an owner or site with no snapshot at all, such as an empty drive, records that and is resumed until a manifest appears. Cursors written before 7.0 record no snapshot and are trusted while any manifest exists, until the next backup rewrites them. |
| Legacy message IDs       | Snapshots created before Atlas used immutable Outlook IDs hold mutable IDs. Mixing the two formats breaks correlation, so the first backup after upgrading runs in full and records `id_format: immutable` in the new manifest. This happens once per mailbox.                                                                                                |

A full enumeration is scoped to the drive or library that triggered it. Delta links are kept per drive, so a site with several libraries, or a user with several drives, keeps working links for the rest. Files in the rebased drive are recorded again as `created`. Files elsewhere keep their history, and an edit there is still reported as `updated`.

### After a snapshot delete

`delete -s` also deletes the owner's delta cursor, and what the next backup reads depends on the workload:

| Workload           | Next backup after `delete -s`                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar, Contacts | Reads every calendar or folder in full, whichever snapshot was deleted. Each manifest is complete, so deleting an older snapshot loses nothing, but the cursor is dropped anyway rather than checking which snapshot it followed.                  |
| Outlook            | Resumes from the delta links stored in the remaining newest snapshot, so it re-reads only the changes since that snapshot, including those the deleted one held. Only the newest snapshot can be deleted, so those links are always the right base. |
| OneDrive, SharePoint | Reads every drive or library in full. Only the newest snapshot can be deleted, because newer ones are built on it. Every file that exists gets an entry in the new snapshot, content already stored is not uploaded again, and files the remaining snapshots list that are gone are recorded as deleted. See [`delete -s`](/reference/cli#drive-snapshot-delete). |

`delete -m`, and `delete` without `-s` on OneDrive and SharePoint, remove the cursor with the rest of the owner's data, so the next backup is a full backup on every workload.

## Deleted and moved messages (Outlook)

```bash
atlas outlook backup -m user@example.com          # records messages deleted since the last run
atlas outlook restore -s <snapshot-id> -T user@example.com
```

An Outlook manifest holds only the messages its run stored, so `restore -s`, `save -s`, and `verify -s` read the snapshot together with every older snapshot of the mailbox. Graph's delta also reports messages deleted from, or moved out of, each folder. Atlas records those IDs in the manifest as `removed_object_ids`, and a removal hides the same message in every older snapshot of the chain. A message deleted before the snapshot is therefore not restored, saved, or verified from it.

A run whose only change is a deletion still writes a snapshot, because the removal exists nowhere else once the delta link moves past it.

Atlas uses immutable message IDs, so a moved message keeps its ID. Graph reports the move as a removal from the old folder and a new message in the new one. A manifest's own entries win over its own removals, which keeps the message at its new location. This only holds when the run captured both folders, so removals are recorded only when every selected folder finished, no `--folder` filter was given, and no folder that can receive mail was excluded. An interrupted run, a folder error, a filtered run, or a run with `--exclude-junk` records none. A message moved into Junk Email by such a run therefore stays restorable from its last captured copy instead of disappearing from the chain.

Excluded hidden system folders such as `Conversation Action Settings`, and the non-mail Recoverable Items subfolders, do not block removals, because mail cannot be moved into them. An unrecognised Recoverable Items subfolder does block them, since Atlas cannot tell what it holds.

A folder deleted while the run lists folders is skipped with a warning and recorded as `deleted-during-listing`. This covers Recoverable Items subfolders too. Mail may have moved into it, so the run counts it as an unfinished folder: it records no removals, and the vanished folder keeps its previous delta link and its stored messages. A `--folder` run records no removals anyway, so it advances its links as usual. The next run no longer lists the folder and records removals as usual.

Withheld removals are not always lost. When a folder fails, vanishes during the listing, or the run is interrupted, every folder that reported a removal keeps its previous delta link, so the next run fetches those changes again and records the removals once every folder finishes. The folder's new messages are fetched again too, and deduplicate against the objects already stored. A folder that fails on every run holds those links back until it succeeds, so fix a persistent folder error rather than leaving it. A filtered or excluded run advances its links anyway, because a mailbox backed up that way on every run would otherwise never move its cursors forward. Removals seen by such a run are dropped.

Some deletions are never reported, and those messages still come back from the chain:

| Case                                             | Why                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A filtered or excluded run                       | `--folder` or `--exclude-junk`. Links advance, so the removals it saw are not reported again.                                                                                                           |
| A full enumeration                               | `--full`, an expired token, or the stale-delta safeguard re-lists the folder. Graph reports what exists, not what was deleted. Removals read before Graph rejected an expired token are still recorded. |
| Snapshots written before Atlas recorded removals | The field is absent, so nothing is hidden.                                                                                                                                                              |

## Commit order for OneDrive and SharePoint

OneDrive and SharePoint keep delta links in a separate cursor object, so one run performs several writes. Atlas writes them in this order:

1. The snapshot manifest, if the run produced entries.
2. The run's version index.
3. The cursor.

A run with no entries skips step 1 and writes the version index, then the cursor.

The order makes a failed run safe to retry. A cursor written first would advance past content that no snapshot references. The next run would then see no changes and report success while the content stayed unreachable.

With the manifest written first, the worst case is repeated work. If the run crashes after the manifest but before the cursor, the next run re-enumerates the same interval and writes a second snapshot. Content is addressed by hash, so the re-upload deduplicates and costs only Graph reads.

This ordering applies per run. A run covering several drives or libraries collects the advanced links in memory and commits them together, after the manifest. A finished drive never has its progress saved ahead of the snapshot that references it.

Outlook follows the same rule: the manifest first, then the cursor. A run that captured nothing and found no deletions writes only the cursor.

## File version capture (OneDrive and SharePoint)

OneDrive and SharePoint backups keep historical file versions as well as the current copy. For every file the delta stream reports as changed, Atlas lists its versions with `GET /drives/{drive-id}/items/{item-id}/versions` and stores each version it has not captured yet. The current version is skipped, because the manifest entry already holds it.

Before it downloads anything, Atlas checks which versions it already holds. It keeps a watermark per file in the cursor:

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

### Why a timestamp and boundary IDs

Graph reports `lastModifiedDateTime` to the second, so two versions can share a timestamp. A timestamp alone could skip a version created later in the same second. Atlas therefore keeps the IDs of every captured version at the newest timestamp, and drops older IDs, because the timestamp already excludes them.

Version IDs are compared for equality only. Graph does not guarantee their format or order, and Atlas never parses or sorts them.

### How the watermark advances

Atlas processes versions oldest first. The watermark stops at the first version the run could not capture:

| Outcome for a version                               | Watermark        | Reason                                                              |
| --------------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| Stored, or already present as a deduplicated object | Advances past it | Atlas holds the content.                                            |
| `404` or `410` from Graph                           | Advances past it | The library's version policy removed it. It can never be retrieved. |
| Any other error, such as `403` or `500`             | Stops before it  | The version may still be retrievable, so the next run retries it.   |

Nothing is dropped silently. A run that fails on an old version retries that version and every newer one on the next run.

A version with a missing or unparseable `lastModifiedDateTime` is never treated as captured. Atlas fetches it again when the file changes, and content addressing prevents duplicate storage.

### Cost

Each run reads the cursor, which it reads anyway. Steady-state backups do not read the version index. A watermark stores one timestamp and the IDs at that timestamp, not the full history. Before watermarks existed, every run scanned the whole version index of the owner or site, which grew too large for the nightly window on large tenants.

### Upgrades and `--full`

A cursor written before watermarks has no watermark map. The first run after upgrading rebuilds it from the version index. The run logs `Seeding version dedup watermarks` and writes exact state to the cursor. A cursor with timestamp-only values upgrades each file when that file next changes. Versions that share the timestamp are captured once more during the conversion.

`--full` does not reset watermarks. It re-reads every file from Graph, but the version history Atlas already holds stays valid, and downloading it again would waste bandwidth. To re-fetch the version history on purpose, delete the version index and the cursor for that owner or site.

## Immutable message IDs

Graph returns two kinds of Outlook identifier. The default ID is mutable: it changes when a message moves between folders, so a message moved into an archive folder looks like a deletion and a new message. Atlas would then download content it already holds, and older manifest entries would point at IDs that Graph no longer resolves.

Atlas therefore sends `Prefer: IdType="ImmutableId"` on every Outlook request: delta pages, message reads, and attachment fetches. Microsoft requires the header on every request that handles an ID, because mixing the two formats breaks correlation. With immutable IDs, a folder move keeps the message's identity. Only the changed folder metadata is stored again.

Immutable IDs are stable within one mailbox, but not across mailboxes. They also change when an item moves into an In-Place Archive or is exported and imported again. See [Obtain immutable identifiers for Outlook resources](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

## Original MIME retrieval

A delta page lists the changed messages. For each new or changed message, Atlas fetches the original **RFC 5322 MIME** bytes and stores them as the canonical encrypted object:

```
GET /users/{id}/messages/{id}/$value
```

The original bytes keep what Graph's JSON does not expose: the `Received:` chain, `Authentication-Results` (DKIM, SPF, and ARC), `In-Reply-To` and `References` threading, and S/MIME payloads. See [Backup fidelity](/security#backup-fidelity).

### Request cost

| Message shape    | Before MIME                                                  | With MIME                                                      |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| No attachments   | None beyond the delta page                                   | One `/$value` request                                          |
| With attachments | One attachment-list request, plus one request per attachment | One `/$value` request, because attachments are inside the MIME |

Each new or changed message costs one request, and a message with attachments costs fewer requests than before. Incremental runs fetch MIME only for changed messages. The first backup of a large mailbox is the expensive case, and the retry policy below absorbs the throttling it causes.

MIME is the only format for new snapshots. There is no `--fidelity` option.

If Graph cannot produce MIME for one item, Atlas stores that item in the legacy JSON form and records the format in its manifest entry. Entries with `payload_format: "mime"` hold original bytes. Entries without the field hold legacy Graph JSON. Snapshots can mix both formats. `save`, `read`, `restore`, and `verify` handle both.

A MIME request that fails is a different case from Graph having no MIME, for example a `503` still failing after the [retries](#retry-and-error-handling). Atlas stores the JSON form so the run keeps the message, reports the message as an error of its folder, and keeps the folder's previous delta link. The run exits 2. The next run fetches the folder's changes again, captures the MIME, and its entry replaces the JSON one in the snapshot chain. A JSON entry whose attachments could not be fetched or stored is handled the same way: the next run fetches the message and its attachments again. A message that fails on every run holds its folder's link back until it succeeds, and the changes refetched each time deduplicate against the stored objects.

### Reactions, flag, and pin

The delta query selects `flag`, so each message's follow-up flag status and its start, due and completed dates arrive with the delta item. A MIME entry records them in its manifest entry as `flag`, because the MIME carries at most an `X-Message-Flag` header. An unflagged message records nothing.

Outlook reactions (like, heart, celebrate and so on) and the pin live in MAPI properties, not in the MIME and not in the delta payload. Outlook pins a message by setting its renew times, `SystemTime 0x0F02` and `SystemTime 0x0F01`, to a far-future date. Graph rejects the `$expand` that would read these properties on the delta query with `400 BadRequest`, so Atlas reads them for each delta page in one `$batch` of up to 20 of these requests:

```
GET /users/{id}/messages/{id}?$select=id&$expand=singleValueExtendedProperties($filter=...)
```

The requests in a batch are chained with `dependsOn`, so Exchange runs them one at a time and the batch never exceeds the four concurrent requests a mailbox allows. Every message still counts once against the per-mailbox budget, because Graph evaluates each request in a batch on its own. What the batch saves is round trips: at the default page size of 10, a first backup of N messages makes N `/$value` requests plus N/10 batch round trips, where it used to make 2N requests. At `--page-size 100` it is N/20. Messages are read in every batch, including messages without reactions and messages whose content deduplicates, because the reactions and pin belong to the manifest entry rather than to the stored object.

Adding a reaction or a flag updates the message's `lastModifiedDateTime`, so the next incremental run picks it up as a changed message.

Only messages with reactions or a pin store anything: their manifest entry gains `reaction_properties` or `pin_properties`. The pin is recorded only when `0x0F01` is present, which it is not on a message that was never pinned. A throttled or failed read inside a batch is retried for that message alone. A read that still fails backs the message up without its reactions and pin, and the run summary prints a warning per folder with the count, because the delta link moves on and those properties are read again only when the message changes. The flag does not depend on this read. A permission or licensing failure stops the mailbox, as it does for MIME. If the configured mailbox connector cannot read these properties at all, Atlas logs that once and captures none.

## Retry and error handling

Atlas retries transient Graph errors with exponential backoff:

| Response                                                  | Behaviour                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `429 Too Many Requests`                                   | Honours `Retry-After`, then backs off exponentially. Up to 12 retries. |
| `500`, `502`, `503`, `504`                                | Same retry policy as `429`.                                            |
| `501` and all other `4xx`                                 | Not retried, because the same request returns the same error.          |
| `syncStateNotFound`, `resyncRequired`, `syncStateInvalid` | The delta token is no longer valid. Atlas resyncs the folder in full.  |

`500` and `502` are retried because Graph returns them for load and gateway faults that clear on their own. Without a retry, one such error would fail the whole folder (Outlook) or drive batch (OneDrive and SharePoint).

`Retry-After` accepts both forms in RFC 9110: a number of seconds, or an HTTP date. A header that is missing, unreadable, or already in the past falls back to exponential backoff. After 12 retries, or once 24 minutes of waiting have passed, Atlas marks the folder as failed and continues with the remaining folders.

## Interruption

| Action        | Result                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First Ctrl+C  | Stops the run. The Graph request in flight and any retry or throttle wait end at once. Completed folders and their delta links are saved to a partial manifest, and the command exits `2`. The dashboard marks interrupted folders. |
| Second Ctrl+C | Exits at once with status `130`. The run writes no manifest, so no delta link moves. Objects already uploaded stay in storage and are deduplicated by the next run.                                                                 |

A partial manifest from the first Ctrl+C is valid. The next run resumes from the saved delta links of the completed folders. The interrupted folder keeps its previous link and is read again from there. Graph has no cancel, so a request it already accepted still completes on its side; Atlas drops the result.

## See also

- [Graph rate limits](/operations/graph-rate-limits): the pools that delta requests draw on
- [Storage layout](/operations/storage-layout): where manifests, cursors, and version indexes are stored
- [Immutability](/operations/immutability): retention for stored versions
