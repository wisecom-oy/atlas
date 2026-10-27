# Delta sync

Atlas uses Microsoft Graph [delta queries](https://learn.microsoft.com/en-us/graph/delta-query-messages) for incremental backups. The first backup reads everything. Later backups fetch only the messages and files that were created, changed, or deleted since the previous run. This reduces bandwidth, Graph requests, and run time.

```bash
atlas outlook backup -m user@example.com -s "$TENANT"          # incremental, uses the saved delta links
atlas outlook backup -m user@example.com -s "$TENANT" --full   # ignore saved delta links
```

## Lifecycle of a delta link

1. **First run.** Atlas requests `/users/{id}/mailFolders/{id}/messages/delta` for each folder, including the message body. Graph pages through every message. The final `@odata.deltaLink` is saved with the snapshot.
2. **Later runs.** Atlas sends the saved link. Graph returns only the changes since the last sync.

A delta link is a Graph URL with an opaque sync token:

```
https://graph.microsoft.com/v1.0/users/.../messages/delta?$deltatoken=aGR2b...
```

The token records the point where the last sync ended. Sending the link back returns only the changes after that point.

::: warning Delta links are sensitive
Delta links are stored inside the encrypted manifest (Outlook) or cursor object (OneDrive and SharePoint), never in plaintext. They hold tenant-scoped sync state. Anyone who obtains one could learn which mailbox items changed. Atlas encrypts manifests and cursors with the tenant data key, so the links are protected at rest. Do not copy them into logs or tickets.
:::

## When Atlas performs a full enumeration

| Trigger                    | Behaviour                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale-delta safeguard      | The saved link returns no items, but the previous manifest stored no entries. The earlier backup was interrupted before storing anything, so Atlas discards the link and enumerates the folder in full. |
| Expired or invalid token   | Graph returns `syncStateNotFound`, `resyncRequired`, or `syncStateInvalid`. Atlas resyncs the folder in full and logs a warning. Tokens lapse after a period of inactivity, and the incremental chain is broken. |
| `--full`                   | `atlas outlook backup --full` ignores every saved link. Use it for periodic audits, or when you suspect a link is corrupt. |
| Legacy message IDs         | Snapshots created before Atlas used immutable Outlook IDs hold mutable IDs. Mixing the two formats breaks correlation, so the first backup after upgrading runs in full and records `id_format: immutable` in the new manifest. This happens once per mailbox. |

A full enumeration is scoped to the drive or library that triggered it. Delta links are kept per drive, so a site with several libraries, or a user with several drives, keeps working links for the rest. Files in the rebased drive are recorded again as `created`. Files elsewhere keep their history, and an edit there is still reported as `updated`.

## Commit order for OneDrive and SharePoint

OneDrive and SharePoint keep delta links in a separate cursor object, so one run performs several writes. Atlas writes them in this order:

1. The snapshot manifest, if the run produced entries.
2. The run's version index.
3. The cursor.

A run with no entries skips step 1 and writes the version index, then the cursor.

The order makes a failed run safe to retry. A cursor written first would advance past content that no snapshot references. The next run would then see no changes and report success while the content stayed unreachable.

With the manifest written first, the worst case is repeated work. If the run crashes after the manifest but before the cursor, the next run re-enumerates the same interval and writes a second snapshot. Content is addressed by hash, so the re-upload deduplicates and costs only Graph reads.

This ordering applies per run. A run covering several drives or libraries collects the advanced links in memory and commits them together, after the manifest. A finished drive never has its progress saved ahead of the snapshot that references it.

Outlook has one write per run, because its delta links live inside the manifest.

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

| Outcome for a version                                             | Watermark        | Reason                                                                       |
| ----------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| Stored, or already present as a deduplicated object               | Advances past it | Atlas holds the content.                                                     |
| `404` or `410` from Graph                                         | Advances past it | The library's version policy removed it. It can never be retrieved.          |
| Any other error, such as `403` or `500`                           | Stops before it  | The version may still be retrievable, so the next run retries it.            |

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

| Message shape    | Before MIME                                                 | With MIME                                                    |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| No attachments   | None beyond the delta page                                  | One `/$value` request                                        |
| With attachments | One attachment-list request, plus one request per attachment | One `/$value` request, because attachments are inside the MIME |

Each new or changed message costs one request, and a message with attachments costs fewer requests than before. Incremental runs fetch MIME only for changed messages. The first backup of a large mailbox is the expensive case, and the retry policy below absorbs the throttling it causes.

MIME is the only format for new snapshots. There is no `--fidelity` option.

If Graph cannot produce MIME for one item, Atlas stores that item in the legacy JSON form and records the format in its manifest entry. Entries with `payload_format: "mime"` hold original bytes. Entries without the field hold legacy Graph JSON. Snapshots can mix both formats. `save`, `read`, `restore`, and `verify` handle both.

## Retry and error handling

Atlas retries transient Graph errors with exponential backoff:

| Response                             | Behaviour                                                            |
| ------------------------------------ | -------------------------------------------------------------------- |
| `429 Too Many Requests`              | Honours `Retry-After`, then backs off exponentially. Up to 12 retries. |
| `500`, `502`, `503`, `504`           | Same retry policy as `429`.                                          |
| `501` and all other `4xx`            | Not retried, because the same request returns the same error.        |
| `syncStateNotFound`, `resyncRequired`, `syncStateInvalid` | The delta token is no longer valid. Atlas resyncs the folder in full. |

`500` and `502` are retried because Graph returns them for load and gateway faults that clear on their own. Without a retry, one such error would fail the whole folder (Outlook) or drive batch (OneDrive and SharePoint).

`Retry-After` accepts both forms in RFC 9110: a number of seconds, or an HTTP date. A header that is missing, unreadable, or already in the past falls back to exponential backoff. After 12 retries, Atlas marks the folder as failed and continues with the remaining folders.

## Interruption

| Action            | Result                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| First Ctrl+C      | Sets the interrupt flag. The current delta page finishes. Stored objects and completed delta links are saved to a partial manifest. The dashboard marks interrupted folders. |
| Second Ctrl+C     | Exits at once. Nothing is saved for work in progress. Folders that finished earlier in the run stay saved.                                    |

A partial manifest from the first Ctrl+C is valid. The next run resumes from the saved delta links of the completed folders. Only the interrupted folder reprocesses from its last saved link.

## See also

- [Graph rate limits](/operations/graph-rate-limits): the pools that delta requests draw on
- [Storage layout](/operations/storage-layout): where manifests, cursors, and version indexes are stored
- [Immutability](/operations/immutability): retention for stored versions
