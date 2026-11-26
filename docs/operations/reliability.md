---
description: What Atlas retries on its own, what happens when a run is stopped or crashes, which exit codes are safe to rerun, and what to check first.
---

# Retries and fail-safes

Atlas retries throttling, server errors, and dropped connections inside a run, saves nothing that points at data it has not stored, and reports anything it could not finish through the exit code. A scheduler needs nothing more than this:

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

The [exit code table](#exit-codes-and-whether-to-retry) says which codes a rerun can fix.

## At a glance

| Failure | What Atlas does | Section |
| --- | --- | --- |
| Microsoft Graph `429`, `500`, `502`, `503`, `504`, network error | Retries up to 12 times with backoff, honouring `Retry-After` | [Microsoft Graph requests](#microsoft-graph-requests) |
| Microsoft Graph outage outlasts the retry budget during a backup | Stops the run after one budget, commits what finished, exits `3` | [When retries run out](#when-retries-run-out-on-a-throttle) |
| A large file transfer stalls or its URL expires | Retries the range, refreshes the URL, resumes at the failed range | [File transfers](#file-transfers-onedrive-and-sharepoint) |
| S3 request fails or the backend stops answering | Retries each request up to 3 times, cuts off a connect after 10 s and a silent socket after 5 min, then exits `3`. Writes that must not collide are conditional | [Storage](#storage) |
| You press Ctrl+C | Commits what finished, exits `2` | [Ctrl+C and signals](#ctrl-c-and-signals) |
| Process killed mid-run | Storage only references what was fully written. The next run resumes from the last saved cursor | [Crash safety and resume](#crash-safety-and-resume) |
| Two runs on one owner | The second one exits `12` and writes nothing | [Concurrency guards](#concurrency-guards) |
| Some items fail, others succeed | The run keeps going, records each failure, and exits `2` | [Partial runs](#partial-runs) |
| Stored data altered, or wrong passphrase | Decryption fails and nothing is restored from it | [Integrity](#integrity) |

## What Atlas retries on its own

### Microsoft Graph requests

Every Microsoft Graph call goes through one retry loop. The Graph SDK's own retry handler is disabled, so retries are never multiplied by a second layer.

| Parameter | Value |
| --- | --- |
| Retried HTTP statuses | `429`, `500`, `502`, `503`, `504` |
| Retried transport errors | Node and undici codes such as `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_SOCKET`, and aborted or timed-out transfers |
| Maximum retries | 12, so at most 13 attempts per call |
| Backoff without `Retry-After` | `min(1 s × 2^attempt + random(0 to 1 s), 5 min)` |
| `Retry-After` | Honoured up to 1 hour, plus a release delay of up to a tenth of the wait, kept between 1 and 5 s. Both RFC 9110 forms are read: seconds or an HTTP date |
| `Retry-After` missing, unreadable, or in the past | Exponential backoff as above |
| `Retry-After` below 1 s | Raised to 1 s |
| `Retry-After` above 1 hour | The call fails at once with `ThrottledError` naming the value. The pool or mailbox still cools down for the hour, for the rest of the run |
| `429` without `Retry-After` | 30 s cooldown for the pool |
| Waiting budget per call | 24 minutes of backoff, `Retry-After`, and cooldown waits. A wait already started runs in full |
| Per-attempt timeout | 60 s by default. A timed-out request is aborted before the next attempt is sent |

`500` and `502` are retried because Microsoft Graph returns them for load and gateway faults that clear on their own. `501` and every other `4xx` are not retried: the same request returns the same answer. A `500` carrying `ErrorMimeContentConversionFailed` is not retried either, because Exchange returns it for an item it can never convert (see [When a message cannot be stored as MIME](/operations/delta-sync#when-a-message-cannot-be-stored-as-mime)). Atlas decides from the HTTP status and structured error codes only, never from message text, which carries request IDs and item IDs whose digits could pass for a status.

An Outlook MIME download (`GET /messages/{id}/$value`) that answers `200` with an empty body is requested again, up to 3 requests in all, 2 s and then 4 s apart. Zero bytes are never an RFC 5322 message, and storing them would pass every later check, since `verify` compares a checksum of zero bytes with zero bytes. If the body stays empty, the message is handled as a failed MIME capture (see [Partial runs](#partial-runs)). Attachments and files can be empty legitimately, so the check covers MIME only. A body shorter than its `Content-Length` fails in transport as `UND_ERR_SOCKET` and is retried as above.

The 24-minute budget sits just above the full exponential schedule (1 + 2 + 4 + ... capped at 5 minutes comes to about 23.5 minutes), so backoff alone always gets all 12 retries. Time spent inside a request does not count, so a slow download keeps its retries. One call therefore waits at most about 24 minutes plus one cooldown, and so does a whole backup run: see [When retries run out](#when-retries-run-out-on-a-throttle).

### Cooldowns shared across requests

A `429` starts a cooldown for every request to the same budget, not only a wait for the one call. Outlook and Teams cooldowns cover one mailbox or team, because Microsoft Graph meters them that way. SharePoint and OneDrive share one tenant-wide cooldown. Overlapping cooldowns do not add up: the longest one wins. When a cooldown ends, waiting requests resume one by one over the release delay instead of in a single burst.

A cooldown keeps the CLI process running only while the command is still working. Once the command has finished or failed, it exits with its code straight away, even when a cooldown of up to an hour is still in force. Requests still waiting on that cooldown are dropped with the process, not sent early.

A host coordinator passed through the SDK fails open: if its shared store is unreachable, requests proceed on their own backoff and a warning is logged, so a coordinator outage never stops a backup. [Throttle handling](/operations/graph-rate-limits#throttle-handling) covers the budgets and the coordinator.

### Pacing

Atlas paces requests below Microsoft's published limits rather than waiting for the first `429`:

| Workload | Pacing |
| --- | --- |
| Outlook | Per mailbox: 9,600 requests per sliding 10-minute window (96% of Microsoft Graph's 10,000) and 4 concurrent requests |
| Teams | 80% of the Microsoft Graph Teams limits, per tenant, per team, and per channel |

A request that finds its mailbox's window spent waits until earlier requests age out of it, up to 10 minutes, and the run then continues. That wait keeps the CLI process running only while the command is still working, like a cooldown does.

Concurrency is fixed, not adaptive. A `429` does not lower it; the shared cooldown is what slows the instance down. `atlas teams backup --concurrency` sets how many channels run at once (default 4, maximum 16).

### When retries run out {#when-retries-run-out-on-a-throttle}

| What ran out | Error | Backup | Restore and save |
| --- | --- | --- | --- |
| A `429` (12 retries or the 24-minute budget), or a `Retry-After` above 1 hour | `ThrottledError` (`ATLAS_THROTTLED`) with the last `Retry-After` attached | The run stops, exit `3` | That item fails and the command continues, exit `2` |
| A `500`, `502`, `503`, `504`, or network error | `GraphUnavailableError` (`ATLAS_GRAPH_UNAVAILABLE`) | The run stops, exit `3` | That item fails and the command continues, exit `2` |

A call that spends its whole budget has met an incident at Microsoft or on the network, not a fault of one item, so a backup treats it as an outage of the whole run. From that moment no Graph call of the run sends a request or starts a wait. Each fails at once with the same error, and requests already sent finish. The run then:

1. Writes the snapshot for every folder, drive, library, calendar, contact folder, or channel it finished before the outage.
2. Leaves each unit it did not finish at its previous sync checkpoint, so the next run reads those changes again. A Graph call the outage stopped is not recorded as a failed file or thread, so it spends none of their retry attempts.
3. Releases the owner lease and exits `3` with the error of the first exhausted call.

One outage therefore holds a backup for about one budget: 1,411 s of backoff for a `503` without `Retry-After` (1 + 2 + 4 + ... + 256 s, then three waits of 300 s), plus the requests in flight.

The scope is one run, meaning one owner under one lease. A host that backs up many owners at once lets each one spend its own budget, because one mailbox's exhausted calls can come from its own Exchange server rather than from all of Microsoft 365, and the shared [cooldowns](#cooldowns-shared-across-requests) already spread a `429` across owners. Within a run the stop covers every pool: a run that cannot read one pool is incomplete and is rerun either way. A command that loops over owners stops at the first one that ends on an outage: `atlas teams backup --all` does not start the next team, and `atlas sharepoint backup --include-subsites` does not start the next subsite.

A call that is not retried to exhaustion stays the item's own failure and the run continues, as described in [Partial runs](#partial-runs). See [Microsoft Graph unavailable after retries](/troubleshooting#microsoft-graph-unavailable-after-retries) for the message and what to do.

### Writes that are sent once

A restore request that creates something (a message, attachment, event, contact, folder, or a drive file under `--conflict rename` or `--conflict fail`) is retried only on a `429`, or a `503` carrying `Retry-After`. Microsoft Graph sends those instead of processing the request.

A `500`, `502`, `504`, timeout, or dropped connection after a create may arrive after Microsoft 365 committed it, so repeating the request could leave a duplicate. The item is reported as failed and the restore continues. See [Restore writes are sent once](/troubleshooting#restore-writes-are-sent-once) for what to check before restoring it again.

Once a restore write is on the wire, Ctrl+C lets it finish, up to its timeout, instead of aborting it. An aborted write might exist in the target while Atlas reports it as not written.

### File transfers (OneDrive and SharePoint)

File content comes from pre-authenticated download URLs rather than through the Graph client, so it has its own retries. Transfers share the `sharepoint_onedrive` cooldown: each waits for it before it starts, and a `429`, or a `503` with `Retry-After`, raises it.

| Parameter | Value |
| --- | --- |
| File-level attempts | 3, with backoff from 2 s capped at 30 s |
| Ranged download | Files over 4 MiB are read in 4 MiB ranges |
| Range timeout | `max(30 s, size in bytes / 256)`, about 33 s for a 4 MiB range |
| Range retries | Up to 5 per range, backoff from 1 s plus up to 1 s of jitter, capped at 30 s. `Retry-After` honoured on `429` |
| Streaming threshold | 64 MiB and above: streamed to storage through a multipart upload |
| Expired URL (`401` or `403` from the CDN) | Looked up again. Files of 64 MiB and more resume at the failed range, until 3 refreshed URLs in a row deliver nothing |
| Truncation check | Each range's length and `Content-Range`, and the total size, must match what Microsoft Graph listed |

A file that still fails is added to the drive's list of failed files, and the drive's sync checkpoint moves on. Each later run fetches the listed files again before processing new changes, up to 5 attempts per file. Failures outside the file do not use an attempt: throttling, a Microsoft Graph `5xx`, a reset or timed-out connection, or a download host that is down, once the retries above are spent, and an expired URL. The same holds for the re-read of a listed file at the start of a run. A `404` on that re-read uses no attempt and keeps the file listed: Atlas drops it as deleted only when the change listing reports the deletion, or when the `404` repeats on 3 runs in a row spanning at least 24 hours. A body of the wrong length or range, and any other `4xx`, use one. [Failed files](/onedrive-backup#failed-files) lists each case and how to fetch a permanently skipped file again. A missing Microsoft Graph permission (`403 accessDenied`) stops the drive instead of costing one file per item. [Snapshot health](/onedrive-backup#snapshot-health) describes the list and the `403` cases.

A failure to write the file to storage is not the file's either, whatever its size: a full disk or quota, an S3 `5xx` after the [storage retries](#storage), or an endpoint that never answers. It fails the drive or library, which keeps its sync checkpoint, so the file is read again by the next run without entering the list. A file of 64 MiB or more is streamed from the download into the multipart upload, and a failure on the storage side of that stream is told apart from a download failure by its type and status, never by its message.

A `404` or `410` on the content of a file version is not taken at its word, because the run listed that version moments earlier and Microsoft Graph returns a `404` during incidents too. Atlas lists the file's versions again: a version that has left the list was purged by retention and is counted as unavailable, not as an error. A version still listed counts as a failed version until the answer repeats on 3 runs in a row spanning at least 24 hours, the rule a failed file's re-read follows. Only the numeric status decides this. [Version failures](/onedrive-backup#version-failures) describes what the run reports.

A file whose content was stored but whose versions were not captured, because the drive failed, the file failed, or Ctrl+C stopped the run in between, is recorded in the cursor. The next run that sees the file captures its versions even though the content is already stored.

During a restore, a file over 4 MiB is uploaded through an upload session in 10 MiB chunks. Each chunk is sent up to 3 times in all: a `429`, `500`, `502`, `503`, or `504` on either of the first two attempts sends it again after `Retry-After` or 1 s. A failed session is not resumed: Atlas deletes it, giving the delete 10 s, and the next restore starts a new one. The final chunk is the request that creates the file, so a checksum mismatch found while streaming abandons the session before anything is created.

### Storage

Atlas uses the AWS SDK for JavaScript v3 with a retry strategy of its own: 3 attempts per request for timeouts, connection errors, throttling (`SlowDown`, `429`), and `500`, `502`, `503`, or `504`, with jittered exponential backoff. Unlike the SDK default, no retry budget is shared between requests, so early failures cannot use up the retries of later ones. A connection that does not open within 10 s, or a socket that stays silent for 5 minutes, ends the attempt. A request the backend never answers fails as `ATLAS_STORAGE_UNAVAILABLE`, exit `3`. [S3 timeouts and retries](/self-hosting/storage#s3-timeouts-and-retries) lists the settings. [Storage request events](/reference/storage-request-events) reports the time each request spent in retries.

| Safeguard | Behaviour |
| --- | --- |
| `Content-MD5` | Sent on every `PutObject`, so the backend rejects a body damaged in transit |
| Create-only writes | Manifests, Teams indexes, version indexes, the data key, and new leases are written with `If-None-Match: *`. An identical object already there is treated as this run's own retried write. A different one fails the run with `ATLAS_STORAGE_FAILURE` and is never overwritten |
| Compare-and-swap | Lease renewal and takeover, the identity registry, and key re-wraps use `If-Match` on the ETag Atlas read |
| Read-back | Manifests, indexes, and delta cursors are read back after upload and compared byte for byte |
| Identity registry contention | Up to 8 attempts, waiting `50 ms × attempt + random(0 to 200 ms)` between them |

::: warning Conditional writes must be enforced
The leases, the data key bootstrap, and the identity registry are only safe on a backend that enforces these conditions. Every command that writes probes the bucket once per process and refuses one that does not, with exit `6`. `atlas storage-check` runs the same probe and reports the result in its `Conditional writes` row. See [Atlas refuses a backend that does not enforce them](/self-hosting/storage#atlas-refuses-a-backend-that-does-not-enforce-them).
:::

See [Create-only snapshot objects and the read-back](/self-hosting/storage#create-only-snapshot-objects-and-the-read-back) and [Metadata is checked before and after it is stored](/security#metadata-is-checked-before-and-after-it-is-stored).

#### Abandoned multipart uploads

Large files are streamed to a staging object through a multipart upload, then promoted. An upload abandoned by a crash keeps its parts, and the bucket keeps billing for them. Three mechanisms collect them:

1. Each OneDrive and SharePoint backup removes staging objects older than 24 hours, and aborts uploads that started more than 24 hours ago and have had no part written since. The second condition keeps a sweep from aborting a slow upload another run is still feeding.
2. Buckets Atlas creates get a lifecycle rule that aborts incomplete multipart uploads after 7 days and expires noncurrent versions after 30 days. The rule is best-effort: a backend that refuses it logs a warning.
3. Deleting an owner's backup aborts all of that owner's uploads at once.

Object Lock retention is set per object at write time, and a delete it refuses exits `8`. See [Immutability and Object Lock](/operations/immutability).

## What happens when a run stops

### Ctrl+C and signals

| Signal | Result |
| --- | --- |
| First Ctrl+C (`SIGINT`) | Soft stop. Microsoft Graph requests, retries, and cooldown waits end at once; restore writes already sent finish. Completed work is committed, the lease is released, and the command exits `2` |
| Second Ctrl+C | Exits at once with `130`. Nothing more is committed and the lease is left to expire, so a run on the same owner within 10 minutes exits `12` |
| `SIGTERM` | Atlas installs no handler, so Node ends the process at once, as with a second Ctrl+C. The shell reports `143` |

The soft stop covers the long-running commands, such as backup, restore, `restore-version`, and save. A command without it ends at once on the first Ctrl+C. A cooldown raised during the run is dropped on Ctrl+C, so an hour-long `Retry-After` does not hold the process open. [Stopping a run](/operations/delta-sync#interruption) describes what a soft-stopped backup saves.

::: tip Soft stop under systemd
`systemctl stop` sends `SIGTERM` by default. Set `KillSignal=SIGINT` in the service unit so a stopped backup commits what it finished and releases its lease, rather than leaving the next run to wait out the 10-minute lease.
:::

### Crash safety and resume

Every workload writes a run in the same order: content first, then the snapshot manifest or index, then the delta cursor. A run that stops anywhere leaves storage pointing only at content that exists.

| Workload | Commit order |
| --- | --- |
| Outlook | Content, manifest, cursor |
| OneDrive, SharePoint | Content, manifest, version index, cursor |
| Contacts, Calendar | Content, manifest, cursor. An interrupted run writes neither |
| Teams | Content, team index, channel cursors |

What an interrupted run leaves behind:

- **Content uploaded before the stop.** Each unique item is stored once, so the next run finds it already stored and skips the upload.
- **No cursor past the last manifest.** The next run starts from the previous cursor and reads the same changes again. A crash between manifest and cursor costs a second snapshot of the same interval and the Microsoft 365 reads, nothing else.
- **Staging objects and multipart parts** for large files, collected as described in [Abandoned multipart uploads](#abandoned-multipart-uploads).
- **The owner lease**, if the process was killed. It expires 10 minutes after its last renewal.

[Commit order for OneDrive and SharePoint](/operations/delta-sync#commit-order-for-onedrive-and-sharepoint) explains why the cursor must come last.

### Delta links

| Situation | What the next run does |
| --- | --- |
| An Outlook folder fails, or a message in it fails | The folder keeps its previous sync checkpoint (delta link), so the run reads those changes again |
| A drive or library fails | That drive keeps its previous checkpoint. Drives that finished advance |
| A drive or library's delta listing ends without `@odata.deltaLink` | The listing stopped early, so the drive fails, keeps its previous checkpoint, and records no deletions. See [Deletions found by a full read](/operations/delta-sync#drive-full-read-deletions) |
| The listing of calendars, contact folders, mail folders, or teams holds fewer items than Microsoft Graph counted | Nothing moves. The run stops before reading any unit and exits `2`. See [Unit listings that end early](#unit-listings) |
| An Outlook folder's delta read ends without `@odata.deltaLink` | The read stopped early, so the folder fails and keeps its previous checkpoint. The run records no removals. See [Retry and error handling](/operations/delta-sync#retry-and-error-handling) |
| Microsoft Graph rejects the checkpoint (`syncStateNotFound`, `resyncRequired`, `syncStateInvalid`) | Reads the folder, drive, or calendar in full |
| Stale-delta safeguard (Outlook) | A saved checkpoint returns nothing while the previous manifest stored nothing: the checkpoint is discarded and the folder read in full |
| The cursor's snapshot was deleted or quarantined | The checkpoints would skip what that snapshot held, so they are ignored and the owner is read in full |
| A stored cursor is damaged | The run stops before writing. A damaged cursor is never treated as absent |

Atlas has no deletion threshold. A large deletion in Microsoft 365 is recorded as deletions in the next snapshot, and earlier snapshots keep every item. [Delta sync](/operations/delta-sync) covers each case.

## Partial runs

A failure that belongs to one item is recorded against that item and the run continues. The command then exits `2` and prints each failure.

| Scope of the failure | Recorded as |
| --- | --- |
| One Outlook message (MIME or attachments) | A message error. The folder keeps its entries but not its new checkpoint, unless Exchange refused the MIME for good, which keeps the checkpoint |
| One Outlook folder | A folder error. The other folders run |
| One OneDrive or SharePoint file | A failed file, retried by the next run up to 5 times |
| One drive or library (for example its delta query) | That drive's error. Other drives run |
| One Teams channel | A channel error. Other channels run. With `--all`, one team's failure does not stop the others |
| One calendar or contact folder | That folder's error |

An exhausted retry budget is never one of these. It stops the backup, see [When retries run out](#when-retries-run-out-on-a-throttle).

Some failures are not the item's fault. Atlas stops the larger unit instead of failing every remaining item the same way. A `403` counts as an `AuthError` here only when its code means a missing permission, see [Which `403` responses stop a run](#forbidden-responses):

| Failure | What stops |
| --- | --- |
| `AuthError` (`ATLAS_AUTH_DENIED`) or `MailboxNotLicensedError` in Calendar or Contacts | The command, with exit `4` |
| `AuthError` in a Teams channel | Sibling channels are cancelled and the command exits `4`. With `--all`, the remaining teams are not started |
| `AuthError` or a missing permission inside a OneDrive drive or SharePoint library | That drive or library, recorded as its error. Other drives still run and the command exits `2` |
| Storage failure while writing a OneDrive or SharePoint file, such as a full disk, a quota, or an S3 `5xx` | That drive or library, recorded as its error with its sync checkpoint kept. Other drives still run and the command exits `2`, or with the storage error's code when the commit then fails too |
| `AuthError` while capturing an Outlook message | That folder, recorded as a folder error. The next folder runs |
| `AuthError` before any item is read, such as resolving the owner | The command, with exit `4` |
| Wrong passphrase, unreadable cursor, storage failure while committing | The command, before anything is written past the last commit |
| A unit listing that ends short of Microsoft Graph's count | The command, before any unit is read, with exit `2`. See [Unit listings that end early](#unit-listings) |

### Which `403` responses stop a run {#forbidden-responses}

Microsoft Graph answers `403 Forbidden` for a missing permission and for other refusals, and only the error code tells them apart. For Outlook, Calendar, Contacts, and Teams, Atlas reads that code:

| Graph error code on the `403` | Reported as | Effect |
| --- | --- | --- |
| `accessDenied`, `ErrorAccessDenied`, `Authorization_RequestDenied` | `MissingGraphPermissionsError` (`ATLAS_AUTH_DENIED`), naming the code and the permissions to grant | Stops as an `AuthError` in the table above, exit `4` |
| `Forbidden` on a Teams call | The same | Teams uses this code for a missing role permission and for a protected API Microsoft has not approved |
| Any other code, or no code | A failure of that request, naming the code Graph sent | Fails the item, channel, folder, or team that request belonged to. The rest of the run continues and the command exits `2` |

The codes are compared without regard to case. A `403` with no code did not come from Graph's permission check, which always sends one. A `403` that reaches the command before any item is read still exits `4`, whatever its code, since an unwrapped `403` maps to `ATLAS_AUTH_DENIED`; the message then names the code. OneDrive and SharePoint classify their own `403` responses, described in [Failed files](/onedrive-backup#failed-files).

### Unit listings that end early {#unit-listings}

Every backup first lists the units it will read: calendars, contact folders, mail folders, Teams channels, and with `atlas teams backup --all` the teams. Microsoft Graph pages a listing with `@odata.nextLink` and ends it with a page that has none. A page that lost its link looks the same as the last page, so a listing that ended early would otherwise be taken as the whole collection, and the units on the pages never read would drop out of the snapshot or be recorded as deleted. Atlas therefore checks every unit listing against a second signal:

| Listing | Check | When the check fails |
| --- | --- | --- |
| Calendars, contact folders, mail folders (every level of the tree), teams for `--all` | Requested with `$count=true`. The pages must hold at least as many items as the latest `@odata.count` Graph reported. A listing whose pages carry no count at all is logged as a warning and not checked | `ListingIncompleteError` (`ATLAS_LISTING_INCOMPLETE`), exit `2`. The run stops before it reads any unit, so no snapshot is written, no checkpoint moves, and nothing is recorded as removed |
| Channels of a team | Microsoft Graph refuses `$count` on this listing with `400`. A channel the previous snapshot holds as live that the listing omits is read by ID instead | Only a `404` marks the channel deleted. A channel Graph still returns keeps its previous entry, checkpoint, and threads unchanged, and is reported as a channel error, exit `2`. Any other error fails the team |

The count costs no extra request. The channel check costs one request for each channel that disappears, once: a channel already marked deleted is not read again. More items than counted is accepted, since a unit created while the listing paged is still a real unit. A unit deleted while the listing paged can leave one fewer than counted, which fails that run; the next run lists again.

## Concurrency guards

Atlas runs one operation at a time per mailbox, drive owner, site, or team. It enforces this with a lease object in storage.

| Guard | Trigger | Result |
| --- | --- | --- |
| Owner lease | A backup, restore, delete, or quarantine starts while another holds the same mailbox, drive owner, site, or team | `ATLAS_OWNER_BUSY`, exit `12`, nothing written |
| Tenant lease | `atlas delete --purge` or a `keys` command runs while any owner lease is live, or the reverse | Exit `12`, or `busy, skipped` and exit `2` for `keys` |
| Lost lease | This run could not renew its lease, or another host took it over | Stops before its next commit, exit `12` |
| Snapshot not newest | `delete -s` names a snapshot newer ones are built on | `ATLAS_SNAPSHOT_NOT_NEWEST`, exit `11` |
| Refused metadata write | A manifest, index, or cursor Atlas built fails its own reader's checks or does not decrypt back | `ATLAS_WRITE_REFUSED`, exit `1`, nothing written |
| Newer format | A stored object was written by a newer Atlas | `ATLAS_FORMAT_UNSUPPORTED`, exit `9` |

| Lease parameter | Value |
| --- | --- |
| Lifetime | 10 minutes after the last renewal |
| Check | Every 60 s the holder reads its lease back, which leaves no version |
| Renewal | Every 5 minutes, by compare-and-swap on the lease's ETag. At most 14 versions per held hour in a versioned bucket |
| Commit margin | A commit is refused once 30 s or less of the lease remain |
| Acquire attempts | 3 |

A storage error during a check or renewal is logged and retried on the next check, a minute later. Only a lease that is gone, replaced, or expired counts as lost. A restore whose storage credentials cannot write the lease (`403`) runs without one and warns that concurrent-run protection is off. [Another operation holds the owner](/troubleshooting#another-operation-holds-the-owner) lists what to do for each case.

::: warning Keep host clocks in sync
Hosts that share a bucket must keep their clocks within a few minutes of each other. A host running ahead sees a live lease as expired and takes it over.
:::

## Integrity

| Check | What it catches |
| --- | --- |
| AES-256-GCM tag | Any change to a stored object. One flipped bit fails decryption |
| Associated data | The header and the object's directory are authenticated, so a ciphertext copied to another owner's path does not decrypt |
| SHA-256 checksum | Checked against the manifest before a restored item is written to Microsoft 365 |
| Wrapped data key | A wrong passphrase fails to unwrap the key before any content is read: `ATLAS_WRONG_PASSPHRASE`, exit `5` |
| `verify` | Downloads, decrypts, and checks the checksum of every object in a snapshot. Outlook, Contacts, and Calendar also offer `--fast`, which only checks that objects exist |

A restore skips an item whose object is missing or fails its tag, names it, restores the rest, and exits `2`. A content object is only read after the snapshot's manifests decrypted under the same key, so a single failing tag means damage to that object, not a wrong key. See [Integrity validation](/security#integrity-validation) for what the tag does and does not prove.

## Key and configuration safety

- `atlas keys rewrap` replaces `_meta/dek.enc` by compare-and-swap, reads the new wrapper back, and proves it opens the same data key. It writes the new passphrase to the configuration only when every tenant succeeded; otherwise it exits `2` and leaves the configuration unchanged. The previous wrapper stays as a noncurrent version on a versioned bucket until `atlas keys purge-old-wrappers` removes it. See [Rewrapping the passphrase](/security#rewrapping-the-passphrase).
- The data key is created with a create-only write. Two runs bootstrapping one tenant agree on one key, and Atlas never generates a key over an existing one. The run that loses logs `another run created the data key first; using it` at info level. A warning that the stored key is not the one the run wrote means the backend accepted a second create-only write; check it with `atlas storage-check`.
- The encrypted config store (`~/.atlas/config.enc`) is written to a temporary file with mode `0600`, flushed to disk, and renamed into place, so a crash leaves the previous file intact. Updates take `~/.atlas/config.lock`, and a second update waits up to 10 s for it. A stale lock is removed only when its process no longer exists on the same host.

::: danger Keep a copy of the passphrase elsewhere
Atlas keeps no copy of the config store or its key. Keep a copy of the passphrase and the S3 credentials somewhere other than the backup host. Without the passphrase the backups cannot be read.
:::

## Restore safety

| Workload | Default |
| --- | --- |
| Outlook | Restores into a new `Restore-<timestamp>` folder, or the folder named by `--destination`. There is no in-place restore, and a well-known folder such as Inbox is refused as a destination |
| OneDrive, SharePoint | Restores under `/Restore-<timestamp>` with `--conflict rename`, so no existing file is overwritten. `--in-place` and `--conflict replace` must be asked for |
| Contacts, Calendar | Items are tagged with their source ID, and a rerun skips those already restored. Nothing is overwritten |
| Cross-tenant | `--target-profile` requires an explicit target, checked before any Microsoft Graph or storage call |

Atlas has no dry-run mode. To check a restore first, restore into the default `Restore-<timestamp>` location, or extract the content with `save`, which writes to a local file and never touches Microsoft 365.

## What to check first

When a scheduled run did not exit `0`:

1. Read the exit code against the [table below](#exit-codes-and-whether-to-retry). It tells you whether a rerun can fix it.
2. Read stderr. A classified failure prints an `Atlas code` line, such as `ATLAS_OWNER_BUSY`, which [Troubleshooting](/troubleshooting) indexes.
3. For exit `3`, check the [Microsoft 365 service health](https://admin.microsoft.com/#/servicehealth) page, and schedule the rerun for later rather than immediately.
4. For exit `2` after a restore, check the target for the reported items before restoring them again, because their create may have committed.
5. For exit `12`, wait for the other operation, or for the lease to expire, before rerunning.

## Exit codes and whether to retry

| Exit | Meaning | Retry unchanged? |
| --- | --- | --- |
| `0` | Complete | |
| `1` | Unclassified failure, storage failure, or `ATLAS_WRITE_REFUSED` | Once, after reading stderr. A persistent `1` needs a person |
| `2` | Partial run, soft interrupt, or items skipped | Backup: yes, the next backup retries failed items. Items lost for good, such as a message Exchange cannot convert to MIME or a file permanently skipped after 5 attempts, are reported but not retried. Restore: first check the target for items whose create may have committed, see [Restore writes are sent once](/troubleshooting#restore-writes-are-sent-once) |
| `3` | Throttled, network failure, Microsoft Graph `5xx`, or an S3 endpoint that never answered, after retries | Yes, later |
| `4` | Authentication, permission, or licence | No. Fix consent or licensing |
| `5` | Wrong passphrase | No. Supply the original passphrase |
| `6` | Invalid configuration | No |
| `7` | Not found | No |
| `8` | Object Lock retention or legal hold | No, not before the retention ends |
| `9` | Unreadable or newer-format stored content | No. Quarantine, `save`, or upgrade Atlas |
| `11` | Snapshot is not the newest | No. Delete newer snapshots first |
| `12` | Owner or tenant busy, or lease lost | Yes, after the other operation ends or within 10 minutes |
| `130` | Second Ctrl+C | Yes |

`StorageError` (`ATLAS_STORAGE_FAILURE`) covers many causes, so its cause decides the exit: `4` for a `401` or `403`, `7` for a `404`, `3` for a network error or a transient status, and `1` otherwise. The full contract, including how scripts should branch, is in [CLI exit codes](/reference/cli#exit-codes).

## See also

- [Graph rate limits](/operations/graph-rate-limits): budgets, limits, and the throttle coordinator
- [Delta sync](/operations/delta-sync): sync checkpoints, full backups, and commit order
- [Troubleshooting](/troubleshooting): fixes by error message
- [Security model](/security): encryption, key hierarchy, and integrity checks
- [Storage](/self-hosting/storage): conditional writes, leases, and Object Lock on the backend
