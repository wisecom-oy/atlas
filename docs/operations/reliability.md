---
description: What Atlas does when Microsoft Graph, the network, storage, or the host fails mid-run. Retry parameters, commit order, leases, partial runs, integrity checks, and which exit codes are worth retrying.
---

# Retries and fail-safes

This page describes what Atlas does when something goes wrong during a run: a throttled or failing Microsoft Graph request, a dropped connection, a storage error, a killed process, or two jobs on the same mailbox. Each section gives the parameters Atlas uses and links to the page that covers the topic in depth.

```bash
status=0
atlas onedrive backup -o user@example.com || status=$?
case "$status" in
  0) ;;                                   # complete
  2) echo "Partial run: the next run retries the failed items" >&2 ;;
  3|12) echo "Transient: schedule another attempt later" >&2 ;;
  *) echo "Needs an operator: read stderr before rerunning" >&2 ;;
esac
exit "$status"
```

A scheduler needs nothing more than this. Atlas retries transient failures inside the run, commits nothing until the data it points at is stored, and reports anything it could not finish through the exit code. The [exit code table](#exit-codes-and-whether-to-retry) at the end says which codes a rerun can fix.

## At a glance

| Failure                                                | What Atlas does                                                                                 | Section                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Graph `429`, `500`, `502`, `503`, `504`, network error | Retries up to 12 times with backoff, honouring `Retry-After`                                    | [Microsoft Graph requests](#microsoft-graph-requests)     |
| A large file transfer stalls or its URL expires        | Retries the chunk, refreshes the URL, resumes at the failed range                               | [File transfers](#file-transfers-onedrive-and-sharepoint) |
| S3 request fails                                       | AWS SDK retries; writes that must not collide are conditional                                   | [Storage](#storage)                                       |
| Process killed mid-run                                 | Storage only references what was fully written; the next run resumes from the last saved cursor | [Crash safety and resume](#crash-safety-and-resume)       |
| Two runs on one owner                                  | The second one exits `12` and writes nothing                                                    | [Concurrency guards](#concurrency-guards)                 |
| Some items fail, others succeed                        | The run keeps going, records each failure, and exits `2`                                        | [Partial runs](#partial-runs)                             |
| Stored data altered or wrong passphrase                | Decryption fails closed; nothing is restored from it                                            | [Integrity](#integrity)                                   |

## Microsoft Graph requests

Every Graph call goes through one retry loop. The Graph SDK's own retry handler is disabled, so retries are never multiplied by a second layer.

| Parameter                     | Value                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Retried HTTP statuses         | `429`, `500`, `502`, `503`, `504`                                                                                                       |
| Retried transport errors      | Node and undici codes such as `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_SOCKET`, and aborted or timed-out transfers |
| Maximum retries               | 12, so at most 13 attempts per call                                                                                                     |
| Backoff without `Retry-After` | `min(1 s × 2^attempt + random(0 to 1 s), 5 min)`                                                                                        |
| `Retry-After`                 | Honoured up to 1 hour, plus a release jitter of up to a tenth of the wait, kept between 1 and 5 s                                       |
| `Retry-After` below 1 s       | Raised to 1 s                                                                                                                           |
| `Retry-After` above 1 hour    | The call fails at once with `ThrottledError` naming the value                                                                           |
| `429` without `Retry-After`   | 30 s cooldown for the pool                                                                                                              |
| Waiting budget per call       | 24 minutes of backoff, `Retry-After`, and cooldown waits. A wait already started runs in full                                           |
| Per-attempt timeout           | 60 s by default. A timed-out request is aborted before the next attempt is sent                                                         |

`501` and every other `4xx` are not retried: the same request returns the same answer. Classification reads the HTTP status and structured error codes only, never message text, because message text carries request IDs and item IDs whose digits could pass for a status.

The 24-minute budget sits just above the full exponential schedule (1 + 2 + 4 + ... capped at 5 minutes comes to about 23.5 minutes), so backoff alone always gets all 12 retries. Time spent inside a request does not count, so a slow download keeps its retries.

### Cooldowns shared across requests

A `429` starts a cooldown on Atlas's throttle coordinator, not only a wait for the one call. Every other request to the same Graph pool waits for it before it is sent, including retries already in their loop. Outlook and Teams cooldowns are scoped to one mailbox or team, because Graph meters them that way; SharePoint and OneDrive share one tenant-wide cooldown. Overlapping cooldowns do not add up: the longest one wins. When a cooldown ends, parked requests resume one by one over the release jitter instead of in a single burst.

A host coordinator passed through the SDK fails open: if its shared store is unreachable, requests proceed on their own backoff and a warning is logged, so a coordinator outage never stops a backup. [Graph rate limits](/operations/graph-rate-limits#throttle-handling) covers the pools and the coordinator in depth.

### Pacing

Atlas paces requests below Microsoft's published limits rather than waiting for the first `429`:

| Workload | Pacing                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Outlook  | Per mailbox: 9,600 requests per sliding 10-minute window (96% of Graph's 10,000) and 4 concurrent requests |
| Teams    | 80% of the Graph Teams limits, per tenant, per team, and per channel                                       |

Concurrency is fixed, not adaptive. A `429` does not lower it; the shared cooldown is what slows the instance down. `atlas teams backup --concurrency` sets how many channels run at once (default 4, maximum 16).

### Writes that are sent once

A restore request that creates something (a message, attachment, event, contact, folder, or a drive file under `--conflict rename` or `--conflict fail`) is retried only on a `429` or a `503` carrying `Retry-After`. Graph sends those instead of processing the request. A `500`, `502`, `504`, timeout, or dropped connection after a create may arrive after Graph committed it, so repeating it could leave a duplicate. The item is reported as failed and the restore continues. See [Restore writes are sent once](/troubleshooting#restore-writes-are-sent-once) for what to check before restoring it again.

Once a restore write is on the wire, Ctrl+C lets it finish, up to its timeout, instead of aborting it. An aborted write might exist in the target while Atlas reports it as not written.

### When retries run out on a throttle

A `429` that outlasts the 12 retries or the 24-minute budget becomes `ThrottledError` (`ATLAS_THROTTLED`), with the last `Retry-After` attached. Inside a folder, file, drive, or channel it fails that unit and the run continues; at the top level it ends the command with exit `3`.

### When retries run out on a 5xx or network error

An exhausted `500`, `502`, `503`, `504`, or network error is passed on unchanged, without an Atlas error code. Where it happens decides the outcome:

- Inside an Outlook folder, a drive or library, a file download, or a Teams channel, it fails that unit, the run carries on with the rest, and the command exits `2`.
- Anywhere else, such as resolving the mailbox or site before any item is read, it ends the command. The CLI classifies it from the HTTP status or the network error code and exits `3`, printing the status but no `Atlas code` line.

## File transfers (OneDrive and SharePoint)

File content is fetched from pre-authenticated download URLs rather than through the Graph client, so it has its own retry layers. They share the `sharepoint_onedrive` cooldown with Graph calls: each transfer waits for the cooldown before it starts, and a `429` or `503` with `Retry-After` raises it.

| Parameter                                 | Value                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| File-level attempts                       | 3, with backoff from 2 s capped at 30 s                                                                           |
| Ranged download                           | Files over 4 MiB are read in 4 MiB ranges                                                                         |
| Range timeout                             | `max(30 s, size in bytes / 256)`, about 33 s for a 4 MiB range                                                    |
| Range retries                             | Up to 5 per range, backoff from 1 s plus up to 1 s of jitter, capped at 30 s; `Retry-After` honoured on `429`     |
| Streaming threshold                       | 64 MiB and above: streamed to storage through a multipart upload                                                  |
| Expired URL (`401` or `403` from the CDN) | Re-resolved. Files of 64 MiB and more resume at the failed range, until 3 refreshed URLs in a row deliver nothing |
| Truncation check                          | Each range's length and `Content-Range`, and the total size, must match what Graph listed                         |

A file that still fails is recorded in the drive's failed-item list and the drive's delta link moves on. Each later run fetches the listed files again before processing new changes, up to 5 attempts per file. Failures that are not the file's fault, such as an expired URL, do not use an attempt. A missing Graph permission (`403 accessDenied`) stops the drive instead of costing one file per item. [Snapshot health](/onedrive-backup#snapshot-health) describes the list and the 403 cases.

A file version Graph reports as gone (`404` or `410`, purged by retention) is counted as unavailable, not as an error. Only the numeric status decides this.

During a restore, a file over 4 MiB is uploaded through a Graph upload session in 10 MiB chunks. Each chunk is sent up to 3 times in all: a `429`, `500`, `502`, `503`, or `504` on either of the first two attempts sends it again after `Retry-After` or 1 s. A failed session is not resumed: Atlas deletes it, giving the delete 10 s, and the next restore starts a new one. The final chunk is the request that creates the file, so a checksum mismatch found while streaming abandons the session before anything is created.

## Storage

Atlas uses the AWS SDK for JavaScript v3 with its default retry strategy: standard mode, 3 attempts in total, with the SDK's own backoff for throttling (`SlowDown`) and `5xx` responses. Atlas sets no request timeout of its own on S3. [Storage request events](/reference/storage-request-events) reports the time each request spent in SDK retries.

| Safeguard                    | Behaviour                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-MD5`                | Sent on every `PutObject`, so the backend rejects a body damaged in transit                                                                                                                                                                                                    |
| Create-only writes           | Manifests, Teams indexes, version indexes, the data key, and new leases are written with `If-None-Match: *`. An identical object already there is treated as this run's own retried write; a different one fails the run with `ATLAS_STORAGE_FAILURE` and is never overwritten |
| Compare-and-swap             | Lease renewal and takeover, the identity registry, and key re-wraps use `If-Match` on the ETag Atlas read                                                                                                                                                                      |
| Read-back                    | Manifests, indexes, and delta cursors are read back after upload and compared byte for byte                                                                                                                                                                                    |
| Identity registry contention | Up to 8 attempts, waiting `50 ms × attempt + random(0 to 200 ms)` between them                                                                                                                                                                                                 |

::: warning Conditional writes must be enforced
The leases, the data key bootstrap, and the identity registry are only safe on a backend that enforces these conditions. `atlas storage-check` writes a probe object and reports a backend that ignores them in its `Conditional writes` row.
:::

See [Create-only snapshot objects and the read-back](/self-hosting/storage#create-only-snapshot-objects-and-the-read-back) and [Metadata is checked before and after it is stored](/security#metadata-is-checked-before-and-after-it-is-stored).

### Abandoned multipart uploads

Large files are streamed to a staging key through a multipart upload, then promoted. An upload abandoned by a crash keeps its parts, and the bucket keeps billing for them. Three mechanisms collect them:

1. Each OneDrive and SharePoint backup removes staging objects older than 24 hours and aborts uploads that started more than 24 hours ago and have had no part written since. The second check keeps a sweep from aborting a slow upload another run is still feeding.
2. Buckets Atlas creates get a lifecycle rule that aborts incomplete multipart uploads after 7 days and expires noncurrent versions after 30 days. The rule is best-effort: a backend that refuses it logs a warning.
3. Deleting an owner's backup aborts all of that owner's uploads at once.

Object Lock retention is set per object at write time and a delete it refuses exits `8`. See [Immutability and Object Lock](/operations/immutability).

## Crash safety and resume

Every workload writes its run in the same shape: content first, then the snapshot manifest or index, then the delta cursor. A run that stops anywhere leaves storage pointing only at content that exists.

| Workload             | Commit order                                                 |
| -------------------- | ------------------------------------------------------------ |
| Outlook              | Content, manifest, cursor                                    |
| OneDrive, SharePoint | Content, manifest, version index, cursor                     |
| Contacts, Calendar   | Content, manifest, cursor. An interrupted run writes neither |
| Teams                | Content, team index, channel cursors                         |

What an interrupted run leaves behind:

- **Content objects uploaded before the stop.** Content is addressed by a keyed hash, so the next run finds each object already stored and skips the upload.
- **No cursor past the last manifest.** The next run starts from the previous cursor and reads the same changes again. A crash between manifest and cursor costs a second snapshot of the same interval and the Graph reads, nothing else.
- **Staging objects and multipart parts** for large files, collected as described in [Abandoned multipart uploads](#abandoned-multipart-uploads).
- **The owner lease**, if the process was killed. It expires 5 minutes after its last renewal.

[Commit order for OneDrive and SharePoint](/operations/delta-sync#commit-order-for-onedrive-and-sharepoint) explains why the cursor must come last.

### Delta links

| Situation                                                                           | Behaviour                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| An Outlook folder fails or a message in it fails                                    | The folder keeps its previous delta link, so the next run reads those changes again                                        |
| A drive or library fails                                                            | That drive keeps its previous link; drives that finished advance                                                           |
| Graph rejects the token (`syncStateNotFound`, `resyncRequired`, `syncStateInvalid`) | The folder, drive, or calendar is read in full                                                                             |
| Stale-delta safeguard (Outlook)                                                     | A saved link returns nothing while the previous manifest stored nothing: the link is discarded and the folder read in full |
| The cursor's snapshot was deleted or quarantined                                    | The links would skip what that snapshot held, so they are ignored and the owner is read in full                            |
| A stored cursor is damaged                                                          | The run stops before writing. A damaged cursor is never treated as absent                                                  |

Atlas has no deletion threshold. A large deletion in Microsoft 365 is recorded as deletions in the next snapshot, and earlier snapshots keep every item. [Delta sync](/operations/delta-sync) covers each case.

### Ctrl+C and signals

| Signal                  | Result                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First Ctrl+C (`SIGINT`) | Soft stop. Graph requests, retries, and cooldown waits end at once; restore writes already sent finish. Completed work is committed, the lease is released, and the command exits `2` |
| Second Ctrl+C           | Exits at once with `130`. Nothing more is committed and the lease is left to expire                                                                                                   |
| `SIGTERM`               | Atlas installs no handler, so Node ends the process at once, as with a second Ctrl+C. The shell reports `143`                                                                         |

The soft stop covers the long-running commands, such as backup, restore, `restore-version`, and save. A command without it ends at once on the first Ctrl+C. A cooldown raised during the run is dropped on Ctrl+C, so an hour-long `Retry-After` does not hold the process open.

::: tip Soft stop under systemd
`systemctl stop` sends `SIGTERM` by default. Set `KillSignal=SIGINT` in the service unit so a stopped backup commits what it finished and releases its lease, rather than leaving the next run to wait out the 5-minute lease.
:::

## Concurrency guards

| Guard                  | Trigger                                                                                                          | Result                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Owner lease            | A backup, restore, delete, or quarantine starts while another holds the same mailbox, drive owner, site, or team | `ATLAS_OWNER_BUSY`, exit `12`, nothing written        |
| Tenant lease           | `atlas delete --purge` or a `keys` command runs while any owner lease is live, or the reverse                    | Exit `12`, or `busy, skipped` and exit `2` for `keys` |
| Lost lease             | This run could not renew its lease, or another host took it over                                                 | Stops before its next commit, exit `12`               |
| Snapshot not newest    | `delete -s` names a snapshot newer ones are built on                                                             | `ATLAS_SNAPSHOT_NOT_NEWEST`, exit `11`                |
| Refused metadata write | A manifest, index, or cursor Atlas built fails its own reader's checks or does not decrypt back                  | `ATLAS_WRITE_REFUSED`, exit `1`, nothing written      |
| Newer format           | A stored object was written by a newer Atlas                                                                     | `ATLAS_FORMAT_UNSUPPORTED`, exit `9`                  |

| Lease parameter  | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Lifetime         | 5 minutes after the last renewal                          |
| Renewal          | Every 60 s, by compare-and-swap on the lease's ETag       |
| Commit margin    | A commit is refused once 30 s or less of the lease remain |
| Acquire attempts | 3                                                         |

A storage error during renewal is logged and retried on the next tick; only a lease that is gone, replaced, or expired counts as lost. Hosts that share a bucket must keep their clocks within a few minutes of each other, because a host running ahead sees a live lease as expired. A restore whose storage credentials cannot write the lease (`403`) runs without one and warns that concurrent-run protection is off. [Another operation holds the owner](/troubleshooting#another-operation-holds-the-owner) lists what to do for each case.

## Partial runs

A failure that belongs to one item is recorded against that item and the run continues. The command then exits `2` and prints each failure.

| Scope of the failure                               | Recorded as                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| One Outlook message (MIME or attachments)          | A message error; the folder keeps its entries but not its new delta link                       |
| One Outlook folder                                 | A folder error; the other folders run                                                          |
| One OneDrive or SharePoint file                    | A failed item, retried by the next run up to 5 times                                           |
| One drive or library (for example its delta query) | That drive's error; other drives run                                                           |
| One Teams channel                                  | A channel error; other channels run. With `--all`, one team's failure does not stop the others |
| One calendar or contact folder                     | That folder's error                                                                            |

Some failures are not the item's fault. Atlas stops the larger unit instead of failing every remaining item the same way:

| Failure                                                                                | What stops                                                                                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AuthError` (`ATLAS_AUTH_DENIED`) or `MailboxNotLicensedError` in Calendar or Contacts | The command, with exit `4`                                                                                  |
| `AuthError` in a Teams channel                                                         | Sibling channels are cancelled and the command exits `4`. With `--all`, the remaining teams are not started |
| `AuthError` or a missing permission inside a OneDrive drive or SharePoint library      | That drive or library, recorded as its error. Other drives still run and the command exits `2`              |
| `AuthError` while capturing an Outlook message                                         | That folder, recorded as a folder error. The next folder runs                                               |
| `AuthError` before any item is read, such as resolving the owner                       | The command, with exit `4`                                                                                  |
| Wrong passphrase, unreadable cursor, storage failure while committing                  | The command, before anything is written past the last commit                                                |

## Integrity

| Check            | What it catches                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AES-256-GCM tag  | Any change to a stored object. One flipped bit fails decryption                                                                                                       |
| Associated data  | The header and the object's directory are authenticated, so a ciphertext copied to another owner's path does not decrypt                                              |
| SHA-256 checksum | Checked against the manifest before a restored item is written to Microsoft 365                                                                                       |
| Wrapped data key | A wrong passphrase fails to unwrap the key before any content is read: `ATLAS_WRONG_PASSPHRASE`, exit `5`                                                             |
| `verify`         | Downloads, decrypts, and checks the checksum of every object in a snapshot. Outlook, Contacts, and Calendar also offer `--fast`, which only checks that objects exist |

A restore skips an item whose object is missing or fails its tag, names it, restores the rest, and exits `2`. A content object is only read after the snapshot's manifests decrypted under the same key, so a single failing tag means damage to that object, not a wrong key. See [Integrity validation](/security#integrity-validation) for what the tag does and does not prove.

## Key and configuration safety

- `atlas keys rewrap` changes `_meta/dek.enc` by compare-and-swap, reads the new wrapper back, and proves it opens the same data key. It writes the new passphrase to the configuration only when every tenant succeeded; otherwise it exits `2` and leaves the configuration unchanged. The previous wrapper stays as a noncurrent version on a versioned bucket until `atlas keys purge-old-wrappers` removes it. See [Rewrapping the passphrase](/security#rewrapping-the-passphrase).
- The data key is created with a create-only write. Two runs bootstrapping one tenant agree on one key, and Atlas never generates a key over an existing one.
- The encrypted config store (`~/.atlas/config.enc`) is written to a temporary file with mode `0600`, flushed to disk, and renamed into place, so a crash leaves the previous file intact. Updates take `~/.atlas/config.lock`, and a second update waits up to 10 s for it. A stale lock is removed only when its process no longer exists on the same host.

::: danger Keep a copy of the passphrase elsewhere
Atlas keeps no copy of the config store or its key. Keep a copy of the passphrase and the S3 credentials somewhere other than the backup host. Without the passphrase the backups cannot be read.
:::

## Restore safety

| Workload             | Default                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outlook              | Restores into a new `Restore-<timestamp>` folder, or the folder named by `--destination`. There is no in-place restore, and a well-known folder such as Inbox is refused as a destination |
| OneDrive, SharePoint | Restores under `/Restore-<timestamp>` with `--conflict rename`, so no existing file is overwritten. `--in-place` and `--conflict replace` must be asked for                               |
| Contacts, Calendar   | Items are tagged with their source ID, and a rerun skips those already restored. Nothing is overwritten                                                                                   |
| Cross-tenant         | `--target-profile` requires an explicit target, checked before any Graph or storage call                                                                                                  |

Atlas has no dry-run mode. To check a restore first, restore into the default `Restore-<timestamp>` location, or extract the content with `save`, which writes to a local file and never touches Microsoft 365.

## Exit codes and whether to retry

| Exit  | Meaning                                                         | Retry unchanged?                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Complete                                                        |                                                                                                                                                                                                                 |
| `1`   | Unclassified failure, storage failure, or `ATLAS_WRITE_REFUSED` | Once, after reading stderr. A persistent `1` needs a person                                                                                                                                                     |
| `2`   | Partial run, soft interrupt, or items skipped                   | Backup: yes, the next backup retries failed items. Restore: first check the target for items whose create may have committed, see [Restore writes are sent once](/troubleshooting#restore-writes-are-sent-once) |
| `3`   | Throttled, network failure, or Graph `5xx` after retries        | Yes, later                                                                                                                                                                                                      |
| `4`   | Authentication, permission, or licence                          | No. Fix consent or licensing                                                                                                                                                                                    |
| `5`   | Wrong passphrase                                                | No. Supply the original passphrase                                                                                                                                                                              |
| `6`   | Invalid configuration                                           | No                                                                                                                                                                                                              |
| `7`   | Not found                                                       | No                                                                                                                                                                                                              |
| `8`   | Object Lock retention or legal hold                             | No, not before the retention ends                                                                                                                                                                               |
| `9`   | Unreadable or newer-format stored content                       | No. Quarantine, `save`, or upgrade Atlas                                                                                                                                                                        |
| `11`  | Snapshot is not the newest                                      | No. Delete newer snapshots first                                                                                                                                                                                |
| `12`  | Owner or tenant busy, or lease lost                             | Yes, after the other operation ends or within 5 minutes                                                                                                                                                         |
| `130` | Second Ctrl+C                                                   | Yes                                                                                                                                                                                                             |

`StorageError` (`ATLAS_STORAGE_FAILURE`) is broad on purpose, so its cause decides the exit: `4` for a `401` or `403`, `7` for a `404`, `3` for a network error or a transient status, and `1` otherwise. The full contract, including how scripts should branch, is in [CLI exit codes](/reference/cli#exit-codes).

## See also

- [Graph rate limits](/operations/graph-rate-limits): pools, limits, and the throttle coordinator
- [Delta sync](/operations/delta-sync): delta links, full enumeration, and commit order
- [Troubleshooting](/troubleshooting): fixes by error message
- [Security model](/security): encryption, key hierarchy, and integrity checks
- [Storage](/self-hosting/storage): conditional writes, leases, and Object Lock on the backend
