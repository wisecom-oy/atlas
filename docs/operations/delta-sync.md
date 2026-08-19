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

The stale-delta safeguard exists to prevent a specific failure: an interrupted backup saving a delta link that skips all the messages it never actually stored.

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
