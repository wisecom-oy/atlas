---
description: 'How Atlas backs up Outlook calendars per mailbox: incremental delta sync, recurring series with exceptions, file attachments, and a restore that never re-invites attendees.'
---

# Calendar backup

Atlas backs up each mailbox's Outlook calendars: the default calendar and every other calendar the mailbox can write to, the events in them, recurring series with their exceptions, and file attachments on events. Calendars are a separate workload from mail and contacts, with their own commands, SDK API, and storage prefix.

```bash
atlas calendar backup -m user@company.com
atlas calendar list -m user@company.com
atlas calendar verify -m user@company.com -s cal-snap-1735689600000-a1b2c3
atlas calendar restore -m user@company.com -s cal-snap-1735689600000-a1b2c3 -T other@company.com
atlas calendar delete -m user@company.com -s cal-snap-1735689600000-a1b2c3
```

Every option is listed in the [CLI reference](/reference/cli#atlas-calendar).

## Permissions

| Operation            | Graph application permission                   |
| -------------------- | ---------------------------------------------- |
| Backup               | `Calendars.Read`                               |
| Restore              | `Calendars.ReadWrite`                          |
| List, verify, delete | None: these read and write backup storage only |

Passing a mailbox as an email address resolves it to an Entra object ID first, which needs `User.Read.All`. Passing the object ID skips that lookup.

A missing grant fails with `ATLAS_AUTH_DENIED` and names the permission to add. Add both calendar permissions before the first calendar run if you plan to restore. See [Entra ID setup](/azure-ad-setup).

Calendar traffic is billed to the Outlook throttling pool, the same pool mail uses. See [Graph rate limits](/operations/graph-rate-limits).

## How a backup runs

1. Atlas lists the mailbox's calendars, default calendar first. Each calendar keeps its Graph ID and display name in the manifest.
2. Calendars the mailbox cannot write to are skipped and counted in `calendars_skipped`. This covers the Birthdays calendar and read-only shared calendars. Their events are not stored. The default calendar is always backed up, even if Graph reports it as read-only.
3. Each remaining calendar gets its own `events/delta` query. The delta link for each calendar is stored encrypted at `calendar/_meta/{mailbox}/delta.json`, so the next run reads only what changed.
4. Changed events are fetched and written as encrypted JSON objects. Unchanged events keep pointing at the objects from the previous run, so an event is stored once however many snapshots include it.
5. Events Graph reports as removed drop out of the next manifest.
6. Atlas writes a new manifest only when something changed. A run that changes nothing writes no snapshot, and `summary.snapshot_created` is `false`.

Each manifest is complete. It lists every calendar and every event that existed at that run, so restoring one snapshot never needs an older one. Snapshots do not chain.

### Interrupted runs

A run that is interrupted (Ctrl+C, a crash, or a process stop) writes neither a manifest nor a new delta cursor. The next run replays the same changes. Nothing is half-recorded, but the replayed work is repeated.

If Graph rejects a stored delta link, Atlas re-reads that calendar from scratch and marks the run as a reset. The re-read gives the complete calendar, so anything absent from it is treated as gone.

## What is captured

| Content                    | Stored as                                                                  |
| -------------------------- | -------------------------------------------------------------------------- |
| Single events              | The Graph event JSON, every property Graph returns                         |
| Recurring series           | The series master with its exception occurrences and cancelled occurrences |
| File attachments on events | Separate encrypted objects, named by keyed HMAC-SHA256 like other content  |
| Calendar list              | Each calendar's ID, display name, and default flag in the manifest         |

### Recurring series

Atlas reads each series master from the Graph beta endpoint with `$expand=exceptionOccurrences`. The master comes back together with its exceptions and cancelled occurrences, so a series is stored whole and an exception is never stored without its master.

Start and end times are requested in the series' own recurrence time zone, sent as a `Prefer: outlook.timezone` header. Without that, Graph returns times in the caller's zone, and a series that crosses a daylight saving change would restore at the wrong local time.

Exchange rejects some zones, for example a custom zone an older client defined, with HTTP 400 and the error code `TimeZoneNotSupportedException`. Only that code makes Atlas read the series again in UTC. Any other error, including a 400 with a different code, fails the event with Graph's message, so a malformed request is not hidden behind a UTC copy.

::: warning Beta endpoint
The `$expand=exceptionOccurrences` read depends on the Graph beta endpoint, which Microsoft may change without the notice a v1.0 API gets. A change there shows up as a backup error on series events, not as silent data loss.
:::

### Attachments

Only file attachments are captured. Each file is stored as its own encrypted object, and the manifest records its name, content type, inline flag, content ID, checksum, and size. The content ID is what a rich-text description uses to reference an inline image (`cid:`), so restore sends it back and embedded images keep rendering.

Item attachments (an attached message or invite) and reference attachments (a link) are not captured, and neither are attachments on a single exception of a series. Each gap is listed in `warnings` and counted in `attachments_skipped`: one per item or reference attachment, and one per exception that carries attachments. A nonzero count makes the run `UNHEALTHY` and exits `2`. The event is still stored and its calendar's delta link still advances, because a rerun cannot capture these attachments either. The next run reports them again only when the event changes or with `--full`.

A file attachment that fails to download or store is different: it fails its event. The event keeps its previous entry, the calendar keeps its old delta link, and the next run fetches the event and its attachments again.

## Restore

```bash
atlas calendar restore -m user@company.com -s cal-snap-1735689600000-a1b2c3 -T other@company.com
```

Without `-T`, events go back to the source mailbox. With `-T`, they go to another mailbox in the same tenant.

Restore only adds. It never overwrites or deletes an event it did not create.

- **Calendars.** A source calendar maps onto the writable target calendar with the same display name, and one that does not exist in the target is created with the source display name. The default calendar maps to the target's default calendar. Names are compared without case, as Exchange does: a target calendar `work` receives the events of a source calendar `Work`. Every calendar in a mailbox is a folder in one namespace, whatever calendar group shows it, and Exchange rejects a second calendar whose name matches an existing one in any group or differs only in case. A name therefore always identifies one calendar, and calendar groups are not recorded or recreated.
- **Duplicates.** An event is skipped and counted in `events_skipped` when the target calendar already holds an event with the same iCalUId, or an event Atlas restored completely earlier from the same source event. Atlas tags each restored event with a single-value extended property to recognise the second case, so re-running a restore does not create copies. Graph gives every created event a new iCalUId, so Atlas also records the original iCalUId in a second extended property. Two snapshot entries with the same iCalUId therefore produce one event, in the same run and on every rerun.
- **Incomplete events.** An event with attachments or recurrence changes is created with a pending tag and receives its complete tag only after every attachment upload and exception or cancellation has succeeded. When one of those writes fails, the error is reported and the event keeps only the pending tag. The next restore deletes that incomplete event and creates it again in full, so a failed attachment is not lost to the skip rule.
- **Recurrence.** The series master is created first. Each exception occurrence is replayed by patching the matching occurrence, and each cancelled occurrence is removed from the restored series. Series keep their time zone, so their local times survive a daylight saving change.
- **Attendees are not re-invited.** Attendees and the organizer are removed from the created event. A text summary of both is written at the top of the event body. Restoring an event does not send invitations, cancellations, or responses to anyone.
- **No new Teams meetings.** Online meeting flags are not sent, so restore never provisions a new Teams meeting. When the original body contains the meeting's join link, Exchange may still show the restored event as an online meeting that points at that original link.

### Why attendees are not re-invited

The backup keeps the complete attendee list: every attendee's address, role (required, optional, resource), and response, plus the organizer. Only the restored event leaves them out.

Microsoft Graph sends a meeting invitation to every attendee as soon as an event is created with an `attendees` array, and it has no flag to suppress that. A restore that wrote attendees back would therefore email every attendee of every meeting in the snapshot: colleagues, external guests, and distribution lists, often for meetings that ended months ago. Meeting rooms and other resources would also receive new booking requests. In a disaster recovery or a restore test, that is thousands of unwanted messages sent in your organisation's name. The organizer is left out for the same reason, and because Exchange assigns it to the mailbox that creates the event.

Restore writes a text summary at the top of the event body instead:

```text
Restored by Atlas. Attendees were not re-invited.
Organizer: Organizer Name <organizer@example.com>
Attendees: Attendee Name <attendee@example.com> (required, accepted); Room 1 <room1@example.com> (resource)
```

The organizer line only appears for meetings the mailbox did not organize. The event otherwise keeps its time, recurrence, location, body, categories, show-as status, reminder, and meeting options.

What changes for the user:

- A restored meeting appears as an appointment in Outlook, without the meeting icon, because it has no attendees.
- Responses are no longer tracked on the event. The summary records what each attendee had answered at backup time.
- To bring a meeting back to life, the user opens the restored event and invites the people listed in the summary. Outlook then sends the invitations, and the user chooses which meetings deserve them.

## Deletion

`atlas calendar delete -m` removes all calendar data for a mailbox. Adding `-s` removes one snapshot manifest and keeps the content objects other snapshots share. `atlas delete --purge` removes calendar data together with the rest of the tenant bucket.

Object Lock retention, when the bucket uses it, applies to calendar objects written under a retention request. See the `--retention-days` and `--lock-mode` options in the [CLI reference](/reference/cli#atlas-calendar).

## Limitations

| Not captured                            | Why it matters                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Attendee and organizer lists on restore | Restored events show them as text only. They are not live invitations.                                                       |
| Teams meeting links as live meetings    | No new meeting is created. The original join link survives in the body; create a new meeting if the old one has expired.     |
| Item and reference attachments          | Reported as warnings and counted in `attachments_skipped`; the run exits `2`. Not recoverable from the backup.               |
| Attachments on single exceptions        | Attachments added to one occurrence of a series are not stored. Reported and counted the same way.                           |
| Read-only calendars                     | Birthdays and read-only shares are skipped. Back them up from their owner if needed.                                         |
| Calendars in replicas                   | Replication and rehydrate refuse calendar snapshots, as they do for contacts. See [Replication](/reference/sdk#replication). |

Restore into a mailbox is a write against live data. Test with a scratch mailbox first, and check the target calendar's event count after the run.

## See also

- [CLI reference: `atlas calendar`](/reference/cli#atlas-calendar)
- [SDK reference: Calendar](/reference/sdk#calendar)
- [Storage layout: Calendar](/operations/storage-layout#calendar)
- [Security model](/security)
