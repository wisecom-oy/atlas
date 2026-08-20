# Delta Sync

Backups use Microsoft Graph [delta queries](https://learn.microsoft.com/en-us/graph/delta-query-messages) for incremental synchronization. After the first backup, only new and changed messages are transferred, which cuts bandwidth, API calls, and runtime.

## How it works

```
First run          Graph returns ALL messages → Atlas stores them → saves deltaLink
                                                                        │
Subsequent run     Atlas sends saved deltaLink ─────────────────────────►│
                   Graph returns ONLY changes  ◄────────────────────────┘
```

1. **Initial run.** Atlas requests `/users/{id}/mailFolders/{id}/messages/delta` with `$select` including the full message body. Graph returns all messages across paginated responses. The final `@odata.deltaLink` URL is saved in the encrypted manifest.

2. **Subsequent runs.** Atlas sends the saved `deltaLink` and Graph returns only messages created, modified, or deleted since the last sync. Incremental runs typically take seconds instead of hours.

## Delta links

A delta link is a Microsoft Graph URL containing an **opaque sync state token**:

```
https://graph.microsoft.com/v1.0/users/.../messages/delta?$deltatoken=aGR2b...
```

The token encodes the exact point in time and state where the last sync ended. Sending the URL back to Graph returns only what changed since the token was issued.

:::: warning Security-sensitive data
Delta links are stored in the **encrypted manifest**, not in plaintext. They contain tenant-scoped API state and could theoretically let an attacker with network access enumerate mailbox changes. Atlas encrypts manifests with the tenant DEK, so delta links are protected at rest.
::::

## When Atlas falls back to a full enumeration

| Trigger                  | Behavior                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stale-delta safeguard** | A saved delta link returns zero items while the previous manifest had zero stored entries. That combination indicates the prior backup was interrupted before storing anything, so Atlas discards the link and enumerates the folder in full. |
| **`syncStateNotFound`**   | Microsoft purges delta tokens after roughly 30 days of inactivity. Atlas detects the error, resyncs the folder in full, and logs a warning so you know the incremental chain was broken. |
| **`--full`**              | `atlas outlook backup --full` ignores every saved delta link. Use it for periodic audits or when you suspect a delta link is corrupted. |
| **Legacy message IDs**    | Snapshots taken before Atlas adopted immutable Outlook IDs recorded mutable IDs in their manifests and delta links. Mixing the two formats would break correlation, so the first backup after upgrading restarts the mailbox in full and stamps the new manifest with `id_format: immutable`. This happens once per mailbox. |

The stale-delta safeguard exists to prevent a specific failure: an interrupted backup saving a delta link that skips all the messages it never actually stored.

## Immutable message IDs

Graph returns two kinds of Outlook identifier. The default ID is **mutable**: it changes whenever a message moves between folders, so a user dragging mail into an archive folder looks like a deletion plus a brand-new message. Atlas would then re-download and re-store content it already held, and older manifest entries would point at IDs Graph no longer resolves.

Atlas therefore sends `Prefer: IdType="ImmutableId"` on every Outlook request — delta pages, single-message reads, and attachment fetches alike. Microsoft requires the header on *every* request that handles an ID, because mixing formats within one dataset corrupts correlation. With it, a folder move keeps the message's identity: the manifest entry stays valid and only the message's changed folder metadata is re-stored.

Two limits are worth knowing. Immutable IDs are stable within a mailbox, but not across mailboxes, and they still change when an item moves into an In-Place Archive or is exported and re-imported. See [Obtain immutable identifiers for Outlook resources](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) for the underlying contract.

## Original MIME retrieval

A delta page tells Atlas which messages changed. For each new or changed message, backup then issues one more request to fetch that message's original **RFC 5322 MIME** -- the on-the-wire form of an email, headers and body parts exactly as the sending and relaying servers produced them -- and stores those bytes as the canonical encrypted object:

```
GET /users/{id}/messages/{id}/$value
```

Earlier versions stored `JSON.stringify()` of roughly 24 selected Graph fields and reconstructed an `.eml` at export time. The original bytes carry the `Received:` chain, `Authentication-Results` with DKIM/SPF/ARC results, `In-Reply-To`/`References` threading, and S/MIME payloads that no Graph field exposes. See [Backup Fidelity](/security#backup-fidelity) for what that recovers and why it matters.

### What it costs per message

| Message shape          | Requests before                                          | Requests now                                              |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| No attachments         | None beyond the delta page, which carried the fields      | One `/$value` fetch                                       |
| With attachments       | One attachment-list request plus one request per attachment | One `/$value` fetch; attachments arrive inside the MIME  |

So the change costs one extra Graph request per new or changed message, offset by no longer issuing an attachment-list request plus one request per attachment. A message that carries attachments therefore costs fewer requests than it did before; a message without any costs one more.

Incremental runs pay this only for messages that actually changed, which is the point of the delta query in the first place. A first full backup of a large mailbox is the expensive case, and the retry logic below -- up to 12 attempts, honoring the server's `Retry-After` header -- absorbs the throttling it provokes without operator involvement.

There is deliberately **no `--fidelity` flag**. MIME is the only mode for new snapshots, so no configuration mistake can quietly archive a year of mail in the weaker format.

If Graph cannot produce MIME for a particular item, Atlas stores that one message in the legacy JSON form and records the format in its manifest entry, so a single unusual item never costs you the rest of the mailbox. Entries with `payload_format: "mime"` hold original bytes; entries without the field hold legacy Graph JSON. Mixed snapshots are expected, and `save`, `read`, `restore`, and `verify` all read both.

## Retry and error handling

Microsoft Graph rate-limits requests to protect the service, and its front end returns transient server errors under load. Atlas handles both transparently:

| Error                                | Behavior                                                           |
| ------------------------------------ | ------------------------------------------------------------------ |
| **HTTP 429** (Too Many Requests)     | Honors `Retry-After` header, exponential backoff, up to 12 retries |
| **HTTP 500** (Internal Server Error) | Same retry logic as 429                                            |
| **HTTP 502** (Bad Gateway)           | Same retry logic as 429                                            |
| **HTTP 503** (Service Unavailable)   | Same retry logic as 429                                            |
| **HTTP 504** (Gateway Timeout)       | Same retry logic as 429                                            |
| **`syncStateNotFound`**              | Delta token expired or invalid. Automatic full resync.             |

`500` and `502` are retried because Graph raises them for load and gateway faults that clear on their own; a single one mid-folder would otherwise fail that folder (Outlook) or discard the drive batch (OneDrive/SharePoint). `501` and every `4xx` are not retried, because repeating them returns the same answer.

Backoff grows with each attempt and respects the server's `Retry-After` header when present. If all 12 retries are exhausted, the folder is marked failed and the backup continues with the remaining folders.

## Interruption behavior

| Action            | What happens                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First Ctrl+C**  | Sets interrupt flag. Current delta page finishes processing. All stored objects and completed delta links are saved to a partial manifest. The dashboard marks interrupted folders. |
| **Second Ctrl+C** | Immediate exit. No manifest is saved for in-progress work. Previously completed folders from this run are still saved.                                                              |

The partial manifest from a first Ctrl+C is usable. Subsequent runs pick up where the interruption occurred, using the delta links saved for completed folders. Only the interrupted folder reprocesses from its last saved delta link.
