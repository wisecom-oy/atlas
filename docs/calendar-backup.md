---
description: 'Back up Outlook calendars per mailbox incrementally, with recurring series and file attachments, and restore events without re-inviting attendees.'
---

# Calendar backup

Atlas backs up each mailbox's Outlook calendars: the default calendar and every other calendar the mailbox can write to, their events, recurring series with their exceptions, and file attachments on events. Calendars are a separate workload from mail and contacts, with their own commands, SDK API, and storage prefix.

## Quick start

```bash
# Back up one mailbox, incrementally
atlas calendar backup -m user@example.com

# List snapshots, then check one
atlas calendar list -m user@example.com
atlas calendar verify -m user@example.com -s cal-snap-1735689600000-a1b2c3

# Restore a snapshot into another mailbox
atlas calendar restore -m user@example.com -s cal-snap-1735689600000-a1b2c3 -T other@example.com
```

`-m` accepts an email address or a Microsoft Entra ID object ID. `backup` prints the ID of each snapshot it creates.

## What is backed up

| Content                    | Stored as                                                                  |
| -------------------------- | -------------------------------------------------------------------------- |
| Single events              | The event as Microsoft Graph returns it, every property included          |
| Recurring series           | The series master with its exception occurrences and cancelled occurrences |
| File attachments on events | Separate encrypted objects, named by keyed HMAC-SHA256 like other content  |
| Calendar list              | Each calendar's ID, display name, and default flag                         |

Each snapshot is complete. It lists every calendar and every event that existed at that run, so restoring one snapshot never needs an older one. An unchanged event is stored once however many snapshots include it. Events Microsoft 365 reports as removed drop out of the next snapshot. The calendar listing is checked against the count Microsoft Graph reports for it, so a listing that ends early stops the run with exit `2` before anything is written, rather than dropping the unlisted calendars from the snapshot. See [Unit listings that end early](/operations/reliability#unit-listings).

Not backed up:

- **Read-only calendars.** The Birthdays calendar and read-only shared calendars are skipped and counted in `calendars_skipped`. Back them up from their owner if needed. The default calendar is always backed up, even if Microsoft Graph reports it as read-only.
- **Item and reference attachments, and attachments on a single occurrence.** See [Attachments](#attachments).
- **Calendar groups.** Calendars are matched by name on restore, so groups are not recorded or recreated.

### Recurring series

A series is stored whole: the master together with its exceptions and cancelled occurrences, so an exception is never stored without its master. Start and end times are read in the series' own recurrence time zone, so a series that crosses a daylight saving change restores at the right local time.

::: warning Beta endpoint
Series are read from the Microsoft Graph beta endpoint (`$expand=exceptionOccurrences`), which Microsoft may change without the notice a v1.0 API gets. A change there shows up as a backup error on series events, not as silent data loss.
:::

::: details Time zones Exchange rejects
Atlas asks for times in the series' zone with a `Prefer: outlook.timezone` header. Exchange rejects some zones, for example a custom zone an older client defined, with HTTP 400 and the error code `TimeZoneNotSupportedException`. Only that code makes Atlas read the series again in UTC. Any other error, including a 400 with a different code, fails the event with Microsoft Graph's message, so a malformed request is not hidden behind a UTC copy.
:::

### Attachments

Only file attachments are captured. Each file is stored as its own encrypted object, and the snapshot records its name, content type, inline flag, content ID, checksum, and size. The content ID is what a rich-text description uses to reference an inline image (`cid:`), so restore sends it back and embedded images keep rendering.

Atlas lists an event's attachments when Microsoft Graph reports `hasAttachments: true`, or when the HTML body contains a `cid:` reference. Graph reports `hasAttachments: false` for an event whose only attachments are inline, such as an image pasted into the body, so the body check is what finds them. The extra cost is one attachment listing for each event that has a `cid:` reference but no attachment flag.

These attachments are not captured:

| Not captured                          | Counted in `attachments_skipped`                    |
| ------------------------------------- | --------------------------------------------------- |
| Item attachments (an attached message or invite) | One per attachment                       |
| Reference attachments (a link)        | One per attachment                                  |
| Attachments on a single exception of a series | One per exception that carries attachments  |
| A `cid:` image the attachment listing does not return | One per image                       |

::: warning Skipped attachments make the run unhealthy
Each gap is listed in `warnings`. A nonzero `attachments_skipped` makes the run `UNHEALTHY` and exits `2`. The event is still stored and its calendar's sync checkpoint still advances, because a rerun cannot capture these attachments either. They are reported again only when the event changes or with `--full`. They are not recoverable from the backup.
:::

A file attachment that fails to download or store is different: it fails its event, and the next run fetches the event and its attachments again. See [When an event cannot be backed up or restored](#when-an-event-cannot-be-backed-up-or-restored).

## Permissions and licensing

| Operation            | Microsoft Graph application permission         |
| -------------------- | ---------------------------------------------- |
| Backup               | `Calendars.Read`                               |
| Restore              | `Calendars.ReadWrite`                          |
| List, verify, delete | None: these read and write backup storage only |

Passing a mailbox as an email address looks it up to an Entra object ID first, which needs `User.Read.All`. Passing the object ID skips that lookup. If you plan to restore, add both calendar permissions before the first calendar run. See [Entra ID setup](/azure-ad-setup).

The mailbox must hold an Exchange Online license. Microsoft Graph does not serve calendars for an unlicensed mailbox.

| Problem              | Error                                                          | Exit |
| -------------------- | -------------------------------------------------------------- | ---- |
| Missing permission   | `ATLAS_AUTH_DENIED`, naming the permission to add              | `4`  |
| Unlicensed mailbox   | `MailboxNotLicensedError` (`ATLAS_MAILBOX_NOT_LICENSED`)       | `4`  |

Both end a backup or restore at once, because no further request can succeed.

A `404` or `400` on the calendar listing is read again, 3 reads in about 6 s, before the run ends on it. One that persists ends the run before anything is written: with `ATLAS_NOT_FOUND` (exit `7`) when the mailbox's user is gone from the directory too, and with `ATLAS_GRAPH_UNAVAILABLE` (exit `3`) otherwise. A `404` on one calendar after the listing fails only that calendar, exit `2`. See [The first read of a run](/operations/reliability#first-reads-of-a-run).

A missing permission is a `403` whose Microsoft Graph code is `accessDenied`, `ErrorAccessDenied`, or `Authorization_RequestDenied`. A `403` with any other code fails only the item it answered, and the run exits `2`. See [Which `403` responses stop a run](/operations/reliability#forbidden-responses).

## Commands

Every command accepts `-t, --tenant <id>` to override the tenant from config. The full option list is in the [CLI reference](/reference/cli#atlas-calendar).

### backup

| Flag                          | Description                                                     | Default        |
| ----------------------------- | --------------------------------------------------------------- | -------------- |
| `-m, --mailbox <email or id>` | Mailbox                                                         | Required       |
| `--full`                      | Ignore the saved sync checkpoints and read every calendar again | `false`        |
| `--retention-days <n>`        | Lock this run's backup data for `n` days with Object Lock       | Off            |
| `--lock-mode <mode>`          | `governance` or `compliance`; requires `--retention-days`       | `governance`   |
| `-t, --tenant <id>`           | Tenant identifier                                               | Config default |

```bash
atlas calendar backup -m user@example.com
atlas calendar backup -m user@example.com --full
```

Atlas lists the mailbox's calendars, default calendar first. Each calendar keeps its own sync checkpoint (a Microsoft Graph `events/delta` link), stored encrypted at `calendar/_meta/{mailbox}/delta.json`, so the next run reads only what changed. A run that changes nothing writes no snapshot, and `summary.snapshot_created` is `false`.

Calendar traffic counts against the Outlook throttling pool, the same pool mail uses. See [Graph rate limits](/operations/graph-rate-limits).

### restore

Restores a snapshot into the source mailbox, or with `-T` into another mailbox in the same tenant. Add `--target-profile` to restore into a mailbox of another tenant. Restore only adds: it never overwrites or deletes an event it did not create.

| Flag                          | Description                                                     | Default        |
| ----------------------------- | --------------------------------------------------------------- | -------------- |
| `-m, --mailbox <email or id>` | Source mailbox                                                  | Required       |
| `-s, --snapshot <id>`         | Snapshot to restore                                             | Required       |
| `-T, --target <email or id>`  | Mailbox to restore into                                         | Source mailbox |
| `--target-profile <name>`     | Tenant profile whose credentials perform a cross-tenant restore. Requires `-T` | None |
| `-t, --tenant <id>`           | Tenant identifier                                               | Config default |

```bash
atlas calendar restore -m user@example.com -s cal-snap-1735689600000-a1b2c3
atlas calendar restore -m user@example.com -s cal-snap-123 --target other@example.com
```

::: warning Restore writes to a live mailbox
Test with a scratch mailbox first, and check the target calendar's event count after the run.
:::

How restore places events:

- **Calendars.** A source calendar maps onto the writable target calendar with the same display name. One that does not exist in the target is created with the source display name. The default calendar maps to the target's default calendar. Names are compared without case, as Exchange does, so a target calendar `work` receives the events of a source calendar `Work`. Exchange keeps every calendar of a mailbox in one namespace, whatever calendar group shows it, and rejects a second calendar whose name matches an existing one or differs only in case, so a name always identifies one calendar.
- **Duplicates.** An event is skipped and counted in `events_skipped` when the target calendar already holds an event with the same iCalUId, or an event Atlas restored completely earlier from the same source event. Atlas tags each restored event with a single-value extended property to recognise the second case, and records the original iCalUId in a second extended property, because Microsoft Graph gives every created event a new iCalUId. Re-running a restore creates no copies, and two snapshot entries with the same iCalUId produce one event, in the same run and on every rerun.
- **Incomplete events.** An event with attachments or recurrence changes is created with a pending tag, and receives its complete tag only after every attachment upload and every exception or cancellation has succeeded. If one of those writes fails, the error is reported and the event keeps only the pending tag. The next restore deletes that incomplete event and creates it again in full, so a failed attachment is not lost to the skip rule. This is the only event a restore ever deletes.
- **Recurrence.** The series master is created first. Each exception is replayed by patching the matching occurrence, and each cancelled occurrence is removed from the restored series. Series keep their time zone, so their local times survive a daylight saving change.
- **Attendees are not re-invited.** Attendees and the organizer are removed from the created event, and a text summary of both is written at the top of the event body. Restoring an event sends no invitations, cancellations, or responses to anyone.
- **No new Teams meetings.** Online meeting flags are not sent, so restore never provisions a new Teams meeting. When the original body contains the meeting's join link, Exchange may still show the restored event as an online meeting that points at that original link. Create a new meeting if the old one has expired.

### Why attendees are not re-invited

The backup keeps the complete attendee list: every attendee's address, role (required, optional, resource), and response, plus the organizer. Only the restored event leaves them out.

Microsoft Graph sends a meeting invitation to every attendee as soon as an event is created with attendees, and it has no flag to suppress that. A restore that wrote attendees back would email every attendee of every meeting in the snapshot: colleagues, external guests, and distribution lists, often for meetings that ended months ago. Meeting rooms and other resources would receive new booking requests. In a disaster recovery or a restore test, that is thousands of unwanted messages sent in your organisation's name. The organizer is left out for the same reason, and because Exchange assigns it to the mailbox that creates the event.

Restore writes a text summary at the top of the event body instead:

```text
Restored by Atlas. Attendees were not re-invited.
Organizer: Organizer Name <organizer@example.com>
Attendees: Attendee Name <attendee@example.com> (required, accepted); Room 1 <room1@example.com> (resource)
```

The organizer line appears only for meetings the mailbox did not organize. The event otherwise keeps its time, recurrence, location, body, categories, show-as status, reminder, and meeting options.

What changes for the user:

- A restored meeting appears as an appointment in Outlook, without the meeting icon, because it has no attendees.
- Responses are no longer tracked on the event. The summary records what each attendee had answered at backup time.
- To bring a meeting back to life, the user opens the restored event and invites the people listed in the summary. Outlook then sends the invitations, and the user chooses which meetings deserve them.

### list

Lists the snapshots stored for a mailbox, newest first.

```bash
atlas calendar list -m user@example.com
```

### verify

Checks every object a snapshot references. A full check decrypts each object and compares it with its recorded SHA-256. `--fast` checks only that each object exists, without downloading or decrypting, which catches missing objects cheaply.

| Flag                          | Description           | Default        |
| ----------------------------- | --------------------- | -------------- |
| `-m, --mailbox <email or id>` | Mailbox               | Required       |
| `-s, --snapshot <id>`         | Snapshot to verify    | Required       |
| `--fast`                      | Existence-only checks | `false`        |
| `-t, --tenant <id>`           | Tenant identifier     | Config default |

```bash
atlas calendar verify -m user@example.com -s cal-snap-123
atlas calendar verify -m user@example.com -s cal-snap-123 --fast
```

A full check lists each damaged object: one the bucket reports as absent, ciphertext that fails authentication, or a checksum mismatch. It exits `1` when a check fails and `2` when interrupted. Any other storage error stops the run.

### delete

| Flag                          | Description                                     | Default        |
| ----------------------------- | ----------------------------------------------- | -------------- |
| `-m, --mailbox <email or id>` | Mailbox                                         | Required       |
| `-s, --snapshot <id>`         | Delete one snapshot instead of every backup     | All data       |
| `-y, --yes`                   | Skip the confirmation prompt                    | `false`        |
| `-t, --tenant <id>`           | Tenant identifier                               | Config default |

```bash
atlas calendar delete -m user@example.com
atlas calendar delete -m user@example.com -s cal-snap-123
```

Without `-s`, every calendar backup for the mailbox is removed. With `-s`, Atlas removes that snapshot's manifest and the mailbox's sync checkpoints, and keeps the event and attachment objects other snapshots share. Each snapshot is complete, so deleting any one leaves the others whole. The next backup reads every calendar in full and captures again what the deleted snapshot held. `atlas delete --purge` removes calendar data together with the rest of the tenant bucket.

::: danger Irreversible
Deletion cannot be undone. Objects written under an Object Lock retention request (`--retention-days`, `--lock-mode`) stay until the retention period ends. See [Erasure](/security#erasure).
:::

### quarantine

Moves an unreadable snapshot manifest to `_quarantine/` so later runs stop reporting it.

```bash
atlas calendar quarantine --key calendar/manifests/<mailbox-id>/<snapshot-id>.json
```

| Flag                  | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `--key <storage-key>` | Storage key a command reported as unreadable (required) |
| `-t, --tenant <id>`   | Tenant identifier                                       |

Only the quarantined snapshot is lost, because every other snapshot is complete. Quarantine also removes the mailbox's sync checkpoints, so the next backup reads the mailbox in full. See [Damaged manifests](/reference/cli#damaged-manifests-and-version-indexes).

## Reading the result

A backup prints `Snapshot <id> created` with `changed`, `stored`, and, when above zero, `removed` counts. It reports how many read-only calendars it skipped, then `Status: HEALTHY` or `Status: UNHEALTHY`. When no snapshot is written it prints one of:

| Output                                                                 | Meaning                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `No calendar changes detected. Snapshot skipped.`                      | Nothing changed since the last run. An earlier snapshot covers it  |
| `No calendar events found. Nothing was backed up and no snapshot exists.` | The mailbox holds no events                                     |
| `No snapshot created: the run was interrupted or every change failed.`  | Check the errors above it                                         |

A restore prints `Events restored`, `Events skipped (already present)`, and `Calendars created`.

| Exit | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| `0`  | Complete                                                                                 |
| `2`  | Partial: an event failed, an attachment was not captured, or the run was interrupted     |
| `3`  | Microsoft Graph kept failing, or the calendar listing kept answering `4xx` for a mailbox that exists. Nothing was written |
| `4`  | Missing permission or unlicensed mailbox                                                 |
| `7`  | The mailbox's user does not exist in the tenant                                          |
| `9`  | A damaged snapshot manifest was found. Run the printed `atlas calendar quarantine` command |

See [Exit codes](/reference/cli#exit-codes) for the full list.

## When an event cannot be backed up or restored

| Situation                                        | What Atlas does                                                                                                            | What you do                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| An event or one of its file attachments fails     | The event keeps its previous entry, its calendar keeps its old sync checkpoint, and the error is reported. Exits `2`       | Nothing. The next run fetches it again |
| An item, reference, or exception attachment is found | Stores the event, lists the gap in `warnings`, counts it in `attachments_skipped`. Exits `2`                            | Nothing can recover it            |
| Microsoft Graph rejects a saved sync checkpoint   | Reads that calendar from the start and marks the run as a reset. Anything absent from the full read is treated as gone    | Nothing                           |
| The run is interrupted (Ctrl+C, crash, process stop) | Writes neither a snapshot nor new sync checkpoints. The next run repeats the same changes; nothing is half-recorded    | Run the backup again              |
| A newer snapshot manifest cannot be read          | Reads every calendar in full, writes a fresh snapshot, names the key, exits `9`                                          | Quarantine the key                |
| A restore write fails for an event with attachments or recurrence | Reports the error. The event keeps its pending tag                                                        | Rerun the restore. It recreates the event in full |
| A restore cannot list the events of a target calendar after retries | Reports each of that calendar's events as failed, naming the listing error, and does not list it again. Other calendars restore. Exits `2` | Rerun the restore once Exchange answers |
| Ctrl+C during a restore                           | An event create, update, or delete already sent finishes and the event is counted. The run then stops and exits `2`. A second Ctrl+C exits `130` at once | Rerun the restore. Events already restored are skipped |
| Missing permission or unlicensed mailbox          | Ends the backup or restore. Exits `4`                                                                                     | Fix consent or licensing          |

## Limits

| Not captured                            | Effect                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Attendee and organizer lists on restore | Restored events show them as text only. They are not live invitations                                          |
| Teams meeting links as live meetings    | No new meeting is created. The original join link survives in the body; create a new meeting if it has expired |
| Item and reference attachments          | Reported as warnings and counted in `attachments_skipped`; the run exits `2`. Not recoverable from the backup  |
| Attachments on single exceptions        | Attachments added to one occurrence of a series are not stored. Reported and counted the same way              |
| Read-only calendars                     | Birthdays and read-only shares are skipped. Back them up from their owner if needed                            |
| Calendar groups                         | Not recorded or recreated                                                                                      |

Series depend on the Microsoft Graph beta endpoint; see [Recurring series](#recurring-series).

## SDK usage

The SDK exposes the same operations on `atlas.calendar`. Options and results use camelCase, and mailbox arguments accept an email address or an object ID.

```ts
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: '<tenant-id>',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<passphrase>',
});

const run = await atlas.calendar.backup('user@example.com');
if (run.summary.attachmentsSkipped > 0) {
  console.warn(run.summary.warnings);
}

if (run.snapshot) {
  const restored = await atlas.calendar.restore('user@example.com', {
    snapshotId: run.snapshot.snapshotId,
    targetMailboxId: 'other@example.com',
  });
  console.log(`Restored ${restored.eventsRestored}, skipped ${restored.eventsSkipped}`);
}
```

| Result             | Fields                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup().summary` | `calendarsScanned`, `calendarsSkipped`, `eventsChanged`, `eventsRemoved`, `objectsStored`, `snapshotCreated`, `noSnapshotReason`, `warnings`, `attachmentsSkipped`, `errors`, `healthy`, `unreadableKeys` |
| `restore()`        | `snapshotId`, `eventsRestored`, `eventsSkipped`, `calendarsCreated`, `errors`, `interrupted`                                                             |

`healthy` is `false` when any event failed or `attachmentsSkipped` is above zero. `snapshotCreated` is `false` for a run that changed nothing. Other methods: `verify`, `listSnapshots`, `listSnapshotSummaries`, `deleteMailboxData`, `deleteSnapshot`, and `quarantine`. See the [SDK reference](/reference/sdk#calendar).

## See also

- [CLI reference: `atlas calendar`](/reference/cli#atlas-calendar)
- [SDK reference: Calendar](/reference/sdk#calendar)
- [Storage layout: Calendar](/operations/storage-layout#calendar)
- [Contacts backup](/contacts-backup)
- [Security model](/security)
