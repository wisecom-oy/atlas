---
description: 'Back up Microsoft Teams channel messages, replies, members, and tabs incrementally through Microsoft Graph, with every blob encrypted before it reaches storage.'
---

# Teams backup

Atlas backs up the channels of Microsoft Teams teams. It stores channel messages with their replies, edits, deletions, and inline images, plus team settings, members, channels, and tabs. Each channel keeps its own delta cursor, so a later run reads only the threads that changed.

Backup, verification, and save are available. `save` exports a snapshot as JSON and browsable HTML. Atlas does not write messages back into Teams; see [Restore](#restore).

## Quick start

```bash
# List the teams the application can read
atlas teams list-teams

# Back up one team
atlas teams backup --team <team-id>

# Back up every team in the tenant
atlas teams backup --all

# Back up a single channel of one team
atlas teams backup --team <team-id> --channel <channel-id>

# Check a snapshot
atlas teams verify --team <team-id> -s <snapshot-id>

# Save one snapshot as a browsable zip
atlas teams save --team <team-id> -s <snapshot-id> --output teams.zip
```

::: warning Protected API
Channel messages are read with `ChannelMessage.Read.All`, a protected Microsoft Graph permission. Microsoft may need to approve it for your tenant before backups succeed. See [Azure AD setup](/azure-ad-setup#teams-application-permissions).
:::

## What is backed up

| Item                                   | Coverage                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Channel messages                       | Every root message in each channel the team hosts, including private channels                                             |
| Replies                                | Each reply is its own blob, linked from its thread. A deleted reply keeps its last live version in `kept`                 |
| Reactions, mentions, edits             | Kept in the raw Graph objects, as Graph returned them. `lastEditedDateTime` shows the last edit                           |
| Inline images                          | Stored as encrypted bytes. The image URLs in each message are kept                                                        |
| System messages                        | Stored with their thread, as Graph returns them                                                                           |
| File attachments                       | Recorded as links. Atlas does not download them. Files live in SharePoint; see [Team files](#team-files)                  |
| Team settings, members, channels, tabs | Raw Graph objects                                                                                                         |

Channels owned by another tenant are skipped with the warning `Channel <id> is owned by another tenant; skipped`.

Each edit writes a new blob, and earlier versions stay in storage for every snapshot that references them. A deleted message keeps its last live version in its `kept` entry.

## Team files

Atlas records where each channel's files live: the files folder's drive ID, item ID, and web URL. It does not download file content. Private and shared channel files can live in SharePoint sites that Teams backup does not back up for you. Back up each of those sites with [SharePoint backup](/sharepoint-backup), and confirm the site appears in `atlas sharepoint list-sites` first. [INFERENCE] `list-sites` searches Graph for sites, so a private or shared channel site may not appear in it. Check the list rather than assume.

## Permissions

Teams backup uses application permissions only. Atlas makes no delegated sign-in and never acts as a user.

| Permission                | Used for                          |
| ------------------------- | --------------------------------- |
| `Team.ReadBasic.All`      | List teams and read team settings |
| `TeamSettings.Read.All`   | Read team settings                |
| `TeamMember.Read.All`     | List team members                 |
| `Channel.ReadBasic.All`   | List channels                     |
| `ChannelMember.Read.All`  | List channel members              |
| `ChannelMessage.Read.All` | Read channel messages and replies |
| `TeamsTab.Read.All`       | Read channel tabs                 |
| `Files.Read.All`          | Find each channel's files folder  |

Consent steps are in [Azure AD setup](/azure-ad-setup#teams-application-permissions).

The files folder call needs `Files.Read.All`, the permission in the table above. Without it, Graph returns `403` for that call. Atlas then marks the channel's files folder unavailable and continues.

## Commands

Team IDs must be Graph team GUIDs. Atlas trims and lowercases the value, so upper-case and lower-case spellings address the same team.

### list-teams

Lists the teams the application can read. Use the IDs it prints with `backup` and `list-snapshots`.

```bash
atlas teams list-teams
```

### backup

Backs up one or more teams. Pass `--team` once per team, or `--all` for every team in the tenant. `--channel <id>` backs up only that channel, needs exactly one `--team`, and cannot be combined with `--all`. Other channels carry forward from the previous snapshot.

```bash
atlas teams backup --team <team-id>
atlas teams backup --team <team-id> --team <other-team-id>
atlas teams backup --all
atlas teams backup --team <team-id> --channel <channel-id>
atlas teams backup --all --concurrency 8
```

Within one team, Atlas backs up up to four channels at once. `--concurrency <n>` sets the number, from 1 to 16. More channels in flight raise throughput only until the team's Graph budget is reached; see [Pacing](#pacing).

Each team runs independently and is reported when it finishes. A channel error is recorded, and the next channel still runs. With several teams, a team that fails with an error other than an authentication error is recorded, and the other teams still run. The run exits `2` when any team is unhealthy: a channel error, a ledger root still listed, or an interrupted run. A run whose only finding is a damaged snapshot index exits `9`, see [Unreadable snapshots](#unreadable-snapshots). A single `--team` run stops on its first error and exits with that error's category code. An authentication error on a team's first channel also stops the run, with exit `4`. See [Failed channels](#failed-channels). The full option list is in the [CLI reference](/reference/cli#atlas-teams).

Each run that creates a snapshot prints these counters:

| Counter | Meaning |
| ------- | ------- |
| `changed` | Threads whose stored record differs from the previous run. New threads count too, and so does a recheck that downloaded an inline image. |
| `stored` | Messages whose blob was written in this run. |
| `dedup` | Messages whose blob already existed, so nothing was written. A forced full read reports unchanged messages here. |
| `hosted` | Inline images written in this run. |
| `deleted` | Threads recorded as deleted in this run. Printed only when above zero. |

After the counters, the run lists each channel with its outcome (`completed`, `incomplete`, `interrupted`, `failed`, or `not_started`), its read mode, and the roots it applied, then the Graph requests per limit class with the achieved rate and the number of `429` answers.

### list-snapshots

Lists the snapshots stored for one team, newest first. An index Atlas cannot read is named with its storage key and the `atlas teams quarantine` command, the rest of the list still prints, and the command exits `9`. One written by a newer Atlas format is named in a warning to upgrade Atlas, and the command also exits `9`. See [Unreadable snapshots](#unreadable-snapshots).

```bash
atlas teams list-snapshots --team <team-id>
```

### verify

Checks the snapshot index, its channel shards, and every message, reply, image, and kept blob the index references. A missing object is reported as missing. An object that cannot be decrypted or parsed, or a blob whose content does not match its SHA-256 checksum, is reported as failed. A shard written by a newer Atlas format is reported as unsupported, and the blobs it lists are not checked. Any missing, failed, or unsupported object makes the command exit `1`.

```bash
atlas teams verify --team <team-id> -s <snapshot-id>
```

### save

Writes one snapshot as a zip archive that opens in a browser without Atlas. `save` reads storage only and makes no Graph calls.

```bash
atlas teams save --team <team-id> -s <snapshot-id> --output teams.zip
atlas teams save --team <team-id> -s <snapshot-id> --channel <channel-id> --output channel.zip
```

The archive holds `team.json`, which lists the saved channels, and one folder per channel with `messages.json` and `index.html`. Each page sets a Content-Security-Policy that allows only inline styles and embedded images. Scripts, frames, forms, `on*` event attributes, and `<meta>` or `<base>` elements are removed from message bodies before the page is written. Hosted images are embedded as `data:` URIs, so the page loads nothing over the network.

Only message bodies are rendered. File attachments are not included. A deleted message shows its last kept version, marked as deleted. A deleted message with no kept version appears as a tombstone.

A message or image that cannot be read is listed in the command output, and the export continues. The command exits `1` in that case, and the archive still holds everything else. Ctrl+C stops the export after the current channel: the archive is still written with the channels finished so far, and the command exits `2`. The full option list is in the [CLI reference](/reference/cli#atlas-teams).

### status

Shows, for each team with a snapshot, the newest snapshot's creation time (`Last snapshot`) and ID. A run that wrote no index does not change it. Below the table, warnings name each team's damaged channel cursors and its channel roots that failed in a previous run. Damaged snapshot indexes and newer-format objects are named after them, and either makes the command exit `9`. `Failed roots` counts the team's failed-root ledger entries across its channel cursors, including `PERMANENTLY SKIPPED` roots. `Pending rechecks` counts hosted content roots still waiting for a recheck. A root that reached the five-attempt cap is not counted.

```bash
atlas teams status
```

### delete

Deletes every Teams backup for one team, in this order: channel cursors, snapshot indexes, channel shards, then message and image blobs. With `-s`, it deletes only that snapshot's index. Its shards and blobs stay, because later snapshots can reference them. A full team delete also removes the quarantined copies of the team's indexes. Atlas asks for confirmation unless you pass `-y`.

```bash
atlas teams delete --team <team-id>
atlas teams delete --team <team-id> -s <snapshot-id>
```

::: danger Irreversible
Deletion cannot be undone. Objects under Object Lock retention stay until the retention period ends.
:::

## How a run finds changes

Each channel is read with its own message delta link.

1. **Delta.** Atlas asks Graph for the messages that changed since the last run. Delta returns only messages from the last eight months. A first run or a forced full read reads older messages too. A new reply, reaction, edit, or deletion returns the root message of its thread. The root's `lastModifiedDateTime` and `etag` do not change for reply activity, so Atlas cannot use them to detect changes.
2. **Root and replies.** For each returned root, Atlas reads the root and its replies. The channel listing asks for 50 roots per page with replies expanded inline. When Graph returns an incomplete reply list, Atlas pages the rest through `/replies`. A root re-fetched from the ledger is read alone, and its replies come from `/replies`.
3. **Per-message blobs and shards.** Each root and reply version is stored as its own blob, holding the Graph object as returned. An unchanged message reuses its blob. A channel's threads are stored as one shard, named by the keyed hash of its contents, so an unchanged channel reuses its shard. A forced full read (`--full`) fetches every root again but never rewrites a blob that already exists, because each blob's name is derived from its content.
4. **Cursor commit.** Atlas writes the snapshot index first, then saves each channel's new delta link. A channel that fails keeps its previous link, so its changes are read again next run.

When nothing changed, Atlas writes no index. A healthy run prints `No Teams changes detected. Snapshot skipped.` The delta cursor is still saved.

A channel is read in full, with no delta link, when it has no channel email address, when no link is stored (a first run, or `--full`), or when Graph rejects the saved link with `400`. A `400` logs a warning and falls back to a full read. The channel is recorded with `read_mode: full` in the manifest. A saved link is used only when its cursor's `baseline_shard_key` equals the shard the latest readable index lists for that channel. Otherwise only that channel is read in full, with a warning. An unreadable cursor is read in full with a warning too.

Deleted messages and channels are carried forward, not dropped. A root or reply that Graph reports as deleted, or a root confirmed gone as described below, is recorded with `deleted_at` set, and its last live version is kept in `kept`. No blob is removed. A channel the team no longer lists keeps `deleted_at` in later indexes.

A root that a full read does not list is not marked removed on that evidence alone. The `/messages` listing is paged newest first, so a root posted or deleted while Atlas pages it shifts the later pages, and a live root can land on no page. After the listing, Atlas reads each live stored root it did not list by ID. Only a `404` marks the root removed. A root Graph still returns is stored as it comes back: live, or deleted with Graph's `deletedDateTime`. Any other error keeps the root live and adds a ledger entry (see [Failed channels](#failed-channels)). This costs one request per unlisted root, plus a reply listing for a root that turns out to be live. A full read that lists every stored root makes no extra requests.

Ctrl+C stops the run. Atlas stops waiting on the request in flight, but Graph has no cancel, so that request still completes on Graph's side and its result is dropped. The root it belonged to is not recorded as a failure, so no ledger entry is added for it. Threads already stored are kept. The interrupted channel keeps its previous delta link and its checkpoint, so the next run resumes its read (see [Resuming an interrupted backup](#resuming-an-interrupted-backup)), and channels not reached carry forward unchanged. Ctrl+C during the team and channel lookups stops the wait. The run then ends at the start of the channel loop, prints `Status: UNHEALTHY`, and exits `2`. A second Ctrl+C exits at once with status `130`. Nothing from that run is referenced: the index is not written, so no cursor moves, and blobs already uploaded stay in storage unreferenced.

## Resuming an interrupted backup

Each channel's read saves its progress after every page of 50 roots. The page's threads go to an encrypted segment, and a head object records where the read stands. Both live under `_meta/{team_id}/checkpoints/{channel_id}/`.

If a run stops partway through a channel, by Ctrl+C or a crash, the next run continues from the last saved page. Pages already applied are not read again.

Each inline image is journaled as its own small encrypted object under `hosted/` in the checkpoint, written just before the image's blob. A resumed run reuses every journaled image whose blob exists instead of downloading it again, and downloads an image whose blob never reached storage. Journaling an image does not rewrite the head or add a segment, so a channel with thousands of images writes one journal object per image and one head per page.

::: tip
A crash can repeat the page that was in flight when it stopped. Graph reads for that page run again, but its content is not stored twice and its images are not downloaded twice.
:::

A checkpoint resumes only when it matches the run: the same baseline shard and the same stored delta link. A `--full` run resumes only a full-read checkpoint. A run without `--full` also resumes a full-read checkpoint, which is what a rejected delta link leaves behind. A checkpoint that does not match, or whose parts cannot be read, is deleted with a warning, and the channel is read from its start.

Checkpoints are written without the run's Object Lock retention (`--retention-days`), because they are rewritten after every page and deleted when the read finishes.

When a channel's read finishes, Atlas saves its cursor first and then deletes the checkpoint. Roots that failed stay in the cursor's failed-root ledger and are retried on the next run.

## Storage layout

Teams objects live under the `teams/` prefix of the tenant bucket.

```
teams/
  data/{team_id}/{content_name}                                   encrypted message and reply blobs
  data/{team_id}/hosted/{content_name}                            encrypted inline images
  manifests/{team_id}/{snapshot_id}.json                          encrypted snapshot indexes
  shards/{team_id}/{channel_id}/{content_name}.json                encrypted channel shards
  _meta/{team_id}/channels/{channel_id}.json                      encrypted channel cursors
  _meta/{team_id}/checkpoints/{channel_id}/                       encrypted read checkpoints (head, segments, hosted/ journal)
```

`content_name` is the keyed name Atlas uses for every content object. It is an HMAC, so it does not match a plain SHA-256 of the content. See [What object names reveal](/security#what-object-names-reveal).

Snapshot indexes, channel shards, and channel cursors carry `format_version: 1`. Blobs do not. An object whose `format_version` is missing or not `1` is unreadable. An object with a higher version is refused with an error that names its key and says to upgrade Atlas.

Known limits of Format 1:
- A reply that Graph stops listing without a deletion notice is carried over as live.
- A reply that Graph deletes before Atlas has listed it is not stored.
- `verify` checks a channel shard by decrypting it, not against its checksum in the index.

## Failed channels

If a channel cannot be read, the run records the error and continues with the next channel. Teams under `--all` or repeated `--team` are isolated the same way.

A thread root that fails is recorded in its channel's cursor, as a ledger entry keyed by root ID. Each run re-fetches ledger roots that the delta read did not return, until the root has failed five times. The report shows `will retry (attempt N of 5)`. After the fifth failure it shows `PERMANENTLY SKIPPED after 5 attempts`, and Atlas stops re-fetching that root, so the channel's delta link can advance. The entry stays in the ledger until a read processes the root cleanly.

A `400` from Graph on a root's replies or re-read is permanent. The root is reported as `PERMANENTLY SKIPPED by service policy, not retried` on the first failure and is not re-fetched.

A root that fails is reported as a channel error. A root that Graph returns `404` for on re-read is kept as previously stored, reported as a warning, and still counts as an attempt. While any ledger entry remains, including a `PERMANENTLY SKIPPED` one, the run reports `Status: UNHEALTHY` and exits `2`, even when that run raised no channel error.

A thread whose inline image Graph did not return is re-checked on later runs. Each run warns `hosted content still missing (attempt N of 5); re-checking next run`. The fifth attempt warns once that Atlas gave up re-checking. The count then stays at 5, so delta runs stop re-checking that root. A full read still lists it and re-applies it. A `404` or `403` from Graph for an inline image is handled the same way and counts as an attempt. These are warnings only, so they do not make the run unhealthy: a run with only these warnings still prints `Status: HEALTHY`.

```bash
status=0
atlas teams backup --all || status=$?
if [ "$status" -eq 2 ]; then
  echo "Some channels failed. Review the report before relying on this run." >&2
elif [ "$status" -eq 9 ]; then
  echo "A snapshot index is damaged. Run the printed atlas teams quarantine command." >&2
fi
exit "$status"
```

See [Exit codes](/reference/cli#exit-codes) for the full list.

## Recovery

### Permanently skipped roots

Retries stop after the fifth failure, but the entry stays in the ledger and keeps the team unhealthy. Check the error in the report first. Then read the root again with a forced full read:

```bash
atlas teams backup --team <team-id> --channel <channel-id> --full
```

A full read processes every root Graph returns for the channel, so a root that now succeeds clears its entry. A root that Graph no longer lists has its entry cleared and is read by ID: a `404` marks it removed.

### Unreadable snapshots

```bash
atlas teams status                       # names the damaged key, exits 9
atlas teams quarantine --key teams/manifests/<team-id>/<snapshot-id>.json
```

An index is unreadable when it cannot be decrypted or parsed, when its team or snapshot ID does not match its key, or when its `created_at` is not a valid timestamp. `status` and `list-snapshots` skip it, name its key with the `atlas teams quarantine` command, and exit `9` (`ATLAS_CONTENT_UNREADABLE`). A backup that skips one newer than the latest readable index does the same, and warns that its baseline is an older snapshot. A channel failure in the same run keeps exit `2`, and the key is still named. A team that fails outright after reading its indexes also names the key, and the failure's own exit code applies. When no readable index exists at all, the backup warns `No readable snapshot exists; every channel is read in full`. This can follow a bucket wipe that Object Lock partly blocked, which leaves legacy manifests behind.

An index with a higher `format_version` is reported as newer-format instead. It is intact, so `quarantine` refuses it. `status` and `list-snapshots` name it, say to upgrade Atlas, and exit `9` (`ATLAS_FORMAT_UNSUPPORTED`). If it is newer than the latest readable index, the backup refuses to write for that team until Atlas is upgraded, also with exit `9`, so it never overwrites the index or treats it as absent.

`quarantine` moves the damaged index to `_quarantine/` with its bytes unchanged, so later `status`, `list-snapshots`, and backup runs stop reporting it. It refuses an index that reads cleanly. The snapshot's shards and blobs stay in storage. The next backup compares against the newest readable index, which is older. Each channel whose cursor no longer matches that index is read in full, as described in [How a run finds changes](#how-a-run-finds-changes), so no `--full` run is needed. See [Damaged manifests](/reference/cli#damaged-manifests-and-version-indexes) for the refusals and Object Lock behaviour.

A damaged channel cursor is not quarantined. `status` names it in a warning, and the next backup reads that channel in full and rewrites the cursor.

### Unreadable channel shards

```bash
atlas teams backup --team <team-id> --channel <channel-id> --full
```

A channel shard is unreadable when the object the latest index names for the channel is missing, cannot be decrypted, is not valid JSON, or does not match its team, channel, or content name. A run without `--full` fails that channel with exit `2` and an error that names the key and the command above. It reads no messages for the channel, and the new index keeps the channel's previous entry.

With `--full`, the run warns with the key and reads the channel as if it were new: every root and its replies from Graph, starting from no stored threads. The stored delta link and any checkpoint bound to the damaged shard are discarded, because both describe content the run cannot see. The failed-root ledger and the inline image recheck counts are kept. The channel gets a readable shard and a cursor bound to it, and the next run reads it by delta again. Message blobs that already exist are not written again.

The rebuilt shard holds what Graph returns now. A message that only the damaged shard held, such as one deleted in Teams since, is not in it. Earlier snapshots that name the damaged key still fail `save` and `verify` for that channel. When the rebuilt content maps to the same key, Atlas writes that object again instead of trusting it, which also repairs those earlier snapshots. The index already names that key, so if nothing else changed the run writes no new snapshot and prints `Repaired N unreadable channel shard(s) in place; no new snapshot needed.` with exit `0`. Otherwise the damaged object stays in storage untouched for inspection.

A storage error while the shard loads, such as a timeout or a dropped connection, is not damage. The channel fails with that error, also under `--full`, and nothing is rebuilt. A shard written by a newer Atlas format is refused as described in [Storage layout](#storage-layout), and `--full` does not rebuild it either.

### Files folder

Atlas keeps each channel's files folder result from the previous run, including an unavailable one. A forced full read is what looks it up again. After granting `Files.Read.All`, run:

```bash
atlas teams backup --team <team-id> --full
```

Without `--full`, the cached result stays in place.

## Pacing

Atlas paces Teams requests before Graph has to throttle them. Microsoft meters Teams reads per application per tenant, and again per team and per channel. Atlas spaces its requests at 80 % of each published limit:

| Scope | Requests | Paced at |
| ----- | -------- | -------- |
| Tenant | Channel messages, replies, and inline images | 16 per second |
| Tenant | Team, members, channels, tabs, and files folder | 24 per second |
| Team | Team, members, channels, tabs, and files folder | 3.2 per second |
| Channel | Channel messages, replies, and inline images | 0.8 per second |

Every request in one Atlas process shares these budgets, including requests from several teams backed up at once. The remaining 20 % leaves room for other applications and for Graph's sustained window, which Microsoft evaluates below the listed rate.

A `429` from one team pauses only that team. Other teams of the tenant keep running. The run then waits out Graph's `Retry-After` for that team, as described in [Throttle handling](/operations/graph-rate-limits#throttle-handling).

A first backup reads every message once, so its duration follows from the channel budget. A channel is read at 0.8 requests per second, and each request returns up to 50 roots with their replies. Back up several teams at once to use the tenant budget: with the default four channels per team, five teams in parallel reach the 16 requests per second the tenant allows.

## Restore

Atlas does not restore messages into Teams. To recover channel content, export a snapshot with [`save`](#save) and open `index.html`, or read `messages.json`.

Microsoft offers one way to write past messages into a channel: the [Teams message import API](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/import-messages/import-external-messages-to-teams). Atlas does not use it:

- **Permission.** The import API needs `Teamwork.Migrate.All`, an application permission that lets the application post messages as any user, with any past timestamp, into any channel of the tenant. A backup application with that permission turns a stolen client secret into a way to forge conversation history. Atlas keeps its Teams permissions read-only.
- **No undo.** Imported messages are new messages. Microsoft's only correction for a wrong import is to delete the team and import again.
- **No merge.** Graph cannot overwrite a message by ID, so an import into a channel that still holds messages duplicates them. Edit history, deletions, and messages from other tenants cannot be imported.

The stored snapshot keeps the raw Graph objects, inline images with their content type, members, and tabs, so a later release can add an import path without a new backup.

## Limits

- **Not covered:** 1:1 chats, group chats, and meeting chats. These belong to individual users and carry separate legal and retention duties. Atlas does not use the metered bulk-export API for them.
- **Restore:** messages are not written back into Teams. See [Restore](#restore).
- **Throttling:** Teams calls use their own throttle pool, separate from OneDrive and SharePoint, and are paced per tenant, team, and channel. See [Pacing](#pacing) and [Graph rate limits](/operations/graph-rate-limits#teams-pool).
- **Replication:** Teams snapshots cannot be replicated or rehydrated yet. Those calls refuse `teams-snap-*` IDs with `Teams snapshots are not replicated yet`.

## SDK usage

The SDK exposes the same operations on `atlas.teams`. Options and results use camelCase. `backup` takes one team per call and returns one result. The CLI loops over `--team` and `--all`. Never run two operations on one team at once. See [Concurrent operations](/reference/sdk#concurrent-operations).

`backup` accepts `concurrency`, the number of channels backed up at once (1 to 16, default 4). The result's `summary` reports `elapsedMs`, one entry per channel in `channels` (`channelId`, `outcome`, `readMode`, `rootsApplied`, `resumedFromCheckpoint`, `elapsedMs`), and `requests.messages` and `requests.default` with `requests`, `throttled`, and `achievedRps`. Each `processing` progress event names the channel that finished in `current` and carries `etaMs`, an estimate of the time left based on the channels finished so far.

To back up many teams, run several `backup` calls at once, one per team. All calls on one Atlas instance share the pacing budgets above. When several processes back up one tenant:

- Give them a shared `throttleCoordinator`. For `teams` requests its `wait` and `raise` receive the team ID as `scope.ownerId`, so a cooldown applies to one team.
- Set `teamsPacingShare` on each instance to its share of the tenant budget, for example `0.25` for four processes. Pacing state lives in each process, so without it four processes would together send up to four times the tenant rate. Team and channel budgets stay whole.
- Run only one operation per team at a time, for example with a lease keyed by the team ID. Two runs on one team would also split its channel budget.

See [Concurrent operations](/reference/sdk#concurrent-operations).

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

const teamId = '<team-id>';

const run = await atlas.teams.backup(teamId);
if (run.snapshot) {
  const check = await atlas.teams.verify(teamId, run.snapshot.snapshotId);
  if (check.failedStorageKeys.length > 0) {
    console.error(`${check.failedStorageKeys.length} blobs failed verification`);
  }
}
```

## See also

- [CLI reference](/reference/cli#atlas-teams)
- [Programmatic SDK](/reference/sdk)
- [Azure AD setup](/azure-ad-setup)
- [SharePoint backup](/sharepoint-backup)
- [Security](/security)
