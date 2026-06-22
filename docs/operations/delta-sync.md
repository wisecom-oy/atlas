# Delta Sync

Backups use Microsoft Graph [delta queries](https://learn.microsoft.com/en-us/graph/delta-query-messages) for incremental synchronization. This means only new and changed messages are transferred after the first backup, dramatically reducing bandwidth, API calls, and runtime.

## How It Works

```
First run          Graph returns ALL messages → Atlas stores them → saves deltaLink
                                                                        │
Subsequent run     Atlas sends saved deltaLink ─────────────────────────►│
                   Graph returns ONLY changes  ◄────────────────────────┘
```

1. **Initial run** — Atlas requests `/users/{id}/mailFolders/{id}/messages/delta` with `$select` including the full message body. The Graph API returns all messages across paginated responses. The final `@odata.deltaLink` URL is saved in the encrypted manifest.

2. **Subsequent runs** — Atlas sends the saved `deltaLink`. The Graph API returns only messages created, modified, or deleted since the last sync. This is what makes incremental backups fast -- typically seconds instead of hours.

3. **Stale-delta safeguard** — if a saved delta link returns zero items but the previous manifest had zero stored entries (indicating the prior backup was interrupted before storing anything), Atlas discards the stale link and runs a full enumeration automatically. This prevents a scenario where an interrupted backup saves a delta link that skips all the messages it never actually stored.

4. **Force full** — `atlas outlook backup --full` ignores all saved delta links and performs a complete enumeration. Useful for periodic audits or when you suspect a delta link may be corrupted.

5. **Graceful interruption** — Ctrl+C during a backup sets an interrupt flag. Atlas finishes processing the current delta page, saves all already-stored objects and completed delta links into a partial manifest, and marks interrupted folders in the dashboard. A second Ctrl+C force-quits immediately without saving.

## Delta Links: What They Are

A delta link is a Microsoft Graph URL containing an **opaque sync state token**. It looks something like:

```
https://graph.microsoft.com/v1.0/users/.../messages/delta?$deltatoken=aGR2b...
```

The token encodes the exact point in time and state where the last sync ended. When you send this URL back to Graph, it returns only what changed since that token was issued.

::: warning Security-Sensitive Data
Delta links are stored in the **encrypted manifest**, not in plaintext. They contain tenant-scoped API state and could theoretically be used by an attacker with network access to enumerate mailbox changes. Atlas encrypts manifests with the tenant DEK, ensuring delta links are protected at rest.
:::

## Retry and Error Handling

Microsoft Graph applies rate limiting to protect the service. Atlas handles this transparently:

| Error | Behavior |
| --- | --- |
| **HTTP 429** (Too Many Requests) | Honors `Retry-After` header, exponential backoff, up to 12 retries |
| **HTTP 503** (Service Unavailable) | Same retry logic as 429 |
| **HTTP 504** (Gateway Timeout) | Same retry logic as 429 |
| **`syncStateNotFound`** | Delta token expired or invalid -- automatic full resync |

When a delta token has expired (Microsoft purges them after ~30 days of inactivity), Graph returns a `syncStateNotFound` error. Atlas detects this and automatically falls back to a full enumeration for that folder, logging a warning so you know the incremental chain was broken.

The 12-retry limit with exponential backoff means Atlas will wait progressively longer between retries (respecting the server's `Retry-After` header when present). If all 12 retries are exhausted, the folder is marked as failed and the backup continues with remaining folders.

## Interruption Behavior

Atlas is designed to handle interruptions safely:

| Action | What Happens |
| --- | --- |
| **First Ctrl+C** | Sets interrupt flag. Current delta page finishes processing. All stored objects and completed delta links are saved to a partial manifest. The dashboard marks interrupted folders. |
| **Second Ctrl+C** | Immediate exit. No manifest is saved for in-progress work. Previously completed folders from this run are still saved. |

The partial manifest from a first Ctrl+C is usable -- subsequent backup runs will pick up where the interruption occurred, thanks to delta links saved for completed folders. Only the interrupted folder needs to re-process from its last saved delta link.
