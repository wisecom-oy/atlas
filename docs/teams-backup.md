---
description: 'Back up Microsoft Teams channel messages, replies, members, and tabs incrementally, encrypted before they reach storage, and export snapshots as browsable archives.'
---

# Teams backup

Atlas backs up the channels of Microsoft Teams teams: channel messages with their replies, edits, deletions, and inline images, plus team settings, members, channels, and tabs. After the first run, each channel is read incrementally, so a run fetches only the threads that changed.

You can back up, verify, and export a snapshot as JSON and browsable HTML. Atlas does not write messages back into Teams; see [Restore](#restore).

## Quick start

```bash
# List the teams the application can read
atlas teams list-teams

# Back up one team, every team, or one channel of a team
atlas teams backup --team <team-id>
atlas teams backup --all
atlas teams backup --team <team-id> --channel <channel-id>

# Check a snapshot, then save it as a browsable zip
atlas teams verify --team <team-id> -s <snapshot-id>
atlas teams save --team <team-id> -s <snapshot-id> --output teams.zip
```

Team IDs are Microsoft Graph team GUIDs. Atlas trims and lowercases the value, so upper-case and lower-case spellings address the same team.

::: warning Protected API
Channel messages are read with `ChannelMessage.Read.All`, a protected Microsoft Graph permission. Microsoft may need to approve it for your tenant before backups succeed. See [Azure AD setup](/azure-ad-setup#teams-application-permissions).
:::

## What is backed up

| Item                                   | Coverage                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Channel messages                       | Every root message in each channel the team hosts, including private channels                                                  |
| Replies                                | Stored per reply and linked from their thread. A deleted reply keeps its last live version                                     |
| Reactions, mentions, edits             | Kept in the message as Microsoft Graph returned it. `lastEditedDateTime` shows the last edit                                   |
| Hosted content                         | Inline images, code snippets, and other hosted objects from the body, attachments, and cards, as encrypted bytes. URLs are kept |
| System messages                        | Stored with their thread                                                                                                       |
| File attachments                       | Recorded as links only. The files live in SharePoint; see [Team files](#team-files)                                            |
| Team settings, members, channels, tabs | Stored as Microsoft Graph returned them                                                                                        |

Each edit stores a new version, and earlier versions stay for every snapshot that references them. A deleted message or channel is carried forward in later snapshots with its last live version (its `kept` entry) and a `deleted_at` time. A channel is marked deleted only after Microsoft Graph answers `404` for it by ID, because the channel listing carries no count to show it is complete. See [Unit listings that end early](/operations/reliability#unit-listings). Nothing is removed from storage when a message is deleted in Teams.

### What is not backed up

- **Chats.** 1:1 chats, group chats, and meeting chats belong to individual users and carry separate legal and retention duties. Atlas does not use the metered bulk-export API for them.
- **File content.** Channel files are recorded by location only. Back them up with SharePoint backup, see [Team files](#team-files).
- **Channels owned by another tenant.** These are skipped with the warning `Channel <id> is owned by another tenant; skipped`. A team whose channels are all foreign backs up nothing, prints `Status: UNHEALTHY`, and exits `2`.

::: warning Pass the tenant GUID
Atlas tells foreign channels apart by comparing each channel's `tenantId` with your tenant, so `-t` must be the tenant GUID. A domain such as `contoso.onmicrosoft.com` fails with a `ConfigError` (exit `6`, `ATLAS_CONFIG_INVALID`) before any Microsoft Graph call. The tenant also names the bucket, so a GUID run writes to `atlas-<guid>`, separate from an `atlas-<domain>` bucket.
:::

### Team files

Atlas records where each channel's files live: the files folder's drive ID, item ID, and web URL. It does not download file content. Private and shared channel files can live in their own SharePoint sites, which Teams backup does not cover. Back up each of those sites with [SharePoint backup](/sharepoint-backup). `atlas sharepoint list-sites` lists the sites Microsoft 365 search returns, so a private or shared channel site may be missing from it. Check the list rather than assume.

## Permissions

Teams backup uses application permissions only. No user signs in, and Atlas never acts as a user.

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

Consent steps are in [Azure AD setup](/azure-ad-setup#teams-application-permissions). Without `Files.Read.All`, Microsoft Graph returns `403` for the files folder lookup. Atlas marks that channel's files folder unavailable and continues; see [Files folder](#files-folder) to fill it in later.

A `403` on any other Teams call stops the run with exit `4` when its code names a missing permission: `accessDenied`, `ErrorAccessDenied`, `Authorization_RequestDenied`, or `Forbidden`, which Teams also returns while Microsoft has not approved `ChannelMessage.Read.All`. A `403` with another code fails only the channel or thread it answered, and the run exits `2`. See [Which `403` responses stop a run](/operations/reliability#forbidden-responses).

## Commands

Every command accepts `-t, --tenant <id>` to override the tenant from config. The full option list is in the [CLI reference](/reference/cli#atlas-teams).

### list-teams

Lists the teams the application can read. Use the IDs it prints with `backup` and `list-snapshots`.

```bash
atlas teams list-teams
```

### backup

| Flag                   | Description                                                                                       | Default        |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| `--team <id>`          | Team to back up. Repeat for several teams                                                         | None           |
| `--all`                | Back up every team in the tenant                                                                  | `false`        |
| `--channel <id>`       | Back up only this channel. Needs exactly one `--team`, not allowed with `--all`                   | All channels   |
| `--full`               | Ignore saved sync checkpoints and cached files folders, and read every channel in full            | `false`        |
| `--concurrency <n>`    | Channels backed up at once within a team, 1 to 16                                                 | `4`            |
| `--retention-days <n>` | Lock the backup data this run writes for `n` days with Object Lock                                | Off            |
| `--lock-mode <mode>`   | `governance` or `compliance`; requires `--retention-days`                                         | `governance`   |
| `-t, --tenant <id>`    | Tenant GUID                                                                                       | Config default |

```bash
atlas teams backup --team <team-id>
atlas teams backup --team <team-id> --team <other-team-id>
atlas teams backup --all --concurrency 8
atlas teams backup --team <team-id> --channel <channel-id>
```

With `--channel`, the other channels carry forward from the previous snapshot. With `--all`, the team listing is checked against the count Microsoft Graph reports for it. A listing that ends early stops the command with `ATLAS_LISTING_INCOMPLETE` and exit `2` before any team is backed up. More channels in flight raise throughput only until the team's request budget is reached; see [Pacing](#pacing).

Each team runs independently and is reported when it finishes. A run that creates a snapshot prints these counters:

| Counter   | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `changed` | Threads that differ from the previous run. New threads count, and so does a recheck that downloaded an inline image    |
| `stored`  | Messages written in this run                                                                                           |
| `dedup`   | Messages already in storage, so nothing was written. A `--full` run reports unchanged messages here                    |
| `hosted`  | Inline images written in this run                                                                                      |
| `deleted` | Threads recorded as deleted in this run. Printed only when above zero                                                  |

After the counters, the run lists each channel with its outcome (`completed`, `incomplete`, `interrupted`, `failed`, or `not_started`), its read mode, and the roots it applied. It then prints the Microsoft Graph requests per limit class, with the achieved rate and the number of `429` (throttled) answers. When nothing changed, no snapshot is written and a healthy run prints:

```text
No Teams changes detected. Snapshot skipped.
```

Exit codes are covered in [Reading the result](#reading-the-result).

### list-snapshots

Lists the snapshots stored for one team, newest first.

```bash
atlas teams list-snapshots --team <team-id>
```

An index Atlas cannot read is named with its storage key and the `atlas teams quarantine` command, the rest of the list still prints, and the command exits `9`. One written by a newer Atlas format is named in a warning to upgrade Atlas, and the command also exits `9`. See [Unreadable snapshots](#unreadable-snapshots).

### verify

Checks the snapshot index, its channel shards, and every message, reply, image, and kept version the index references.

```bash
atlas teams verify --team <team-id> -s <snapshot-id>
```

| Finding     | Meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| missing     | The object is not in storage                                                              |
| failed      | The object cannot be decrypted or parsed, or its content does not match its SHA-256       |
| unsupported | A shard written by a newer Atlas format. The objects it lists are not checked             |

Any finding makes the command exit `1`.

### save

Writes one snapshot, or one channel of it, as a zip archive that opens in a browser without Atlas. `save` reads storage only and makes no Microsoft Graph calls.

| Option                | Description                                 | Default                                |
| --------------------- | ------------------------------------------- | -------------------------------------- |
| `--team <id>`         | Team ID                                     | Required                               |
| `-s, --snapshot <id>` | Snapshot to save                            | Required                               |
| `--channel <id>`      | Save only this channel                      | All channels                           |
| `--output <path>`     | Zip file to write                           | `teams-<snapshot-id>-<timestamp>.zip`  |
| `-y, --yes`           | Overwrite an existing output without asking | `false`                                |
| `-t, --tenant <id>`   | Override the tenant ID from config          | Config default                         |

```bash
atlas teams save --team <team-id> -s <snapshot-id> --output teams.zip
atlas teams save --team <team-id> -s <snapshot-id> --channel <channel-id> --output channel.zip
```

If `--output` names an existing file, Atlas asks `Overwrite? [Y/n]` before it reads storage. Answering `n` exits `0` and leaves the file as it was. With stdin at EOF, as under cron or systemd with `/dev/null`, no answer is read, so the command exits `1` and the file is untouched. Pass `-y` in scheduled jobs. The question is asked by default because a previous export can be the only copy of a snapshot that retention has since removed.

The archive layout:

```text
team.json                                                 saved channels and the team's members
channels/<channel>/messages.json                          channel, members, tabs, files folder, shared-with teams, threads
channels/<channel>/index.html                             the messages as a page
channels/<channel>/hosted/<message-id>/<content-id>.<ext> hosted content files
```

`messages.json` holds the channel as the backup stored it:

| Field                      | Content                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `members`                  | The channel's own members. Empty when `members_from_team` is `true`; the team's members are in `team.json` |
| `tabs`                     | The channel's tabs                                                                                        |
| `files_folder`             | Drive ID, item ID, and web URL of the Files folder, or `null` when none was stored                        |
| `files_folder_unavailable` | `true` when Microsoft Graph refused the folder lookup with `403`                                          |
| `shared_with_teams`        | Teams a shared channel is shared with, or `null` for a standard channel                                   |
| `hosted` (per message)     | Saved hosted files as `{ id, content_type, path }`                                                        |
| `hosted_missing` (per message) | IDs of hosted contents the backup never captured                                                      |

Use `path` in `messages.json` to find a hosted file, not its ID. An ID longer than 64 characters, or one with characters other than letters, digits, `_` and `-`, is shortened in the file name to a 32-character prefix and 16 hex characters of its SHA-256.

Every hosted content of a message is saved as its own file: inline images, code snippets, and the objects that attachments and cards reference. PNG, JPEG, GIF, BMP, WebP, and plain text keep their extension. HTML is saved as `.txt` and every other type as `.bin`, so no file in the archive runs when opened.

The HTML page is built to be safe to open:

- It embeds inline images as `data:` URIs and loads nothing over the network.
- It sets a Content-Security-Policy that allows only inline styles and embedded images.
- Scripts, frames, forms, `on*` event attributes, and `<meta>` or `<base>` elements are removed from message bodies.
- Cards and attachments are not rendered. Their hosted files are in the archive, and `messages.json` keeps their JSON. Other hosted files are linked only from `messages.json`.

A deleted message shows its last kept version, marked as deleted, or a tombstone when no version was kept. A kept version does not record missed hosted content, so its `hosted_missing` is empty. File attachments stay as links in `messages.json`; the files stay in SharePoint.

| Problem                                                                                                         | Exit |
| --------------------------------------------------------------------------------------------------------------- | ---- |
| A message, reply, or hosted file could not be read or failed its checksum. It is left out of the archive        | `1`  |
| Hosted content the backup never captured (`hosted_missing`). The `<img>` keeps its Graph URL and the summary lists it | `2`  |
| Ctrl+C. The archive is still written with the channels finished so far                                          | `2`  |

The archive holds everything else in each case. An error takes precedence over the `2` for uncaptured content.

### status

Shows each team with a snapshot: the newest snapshot's creation time (`Last snapshot`) and ID, plus two health counts.

```bash
atlas teams status
```

| Column             | Meaning                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Failed roots`     | Threads in the team's list of failed threads, including `PERMANENTLY SKIPPED` ones. See [Failed channels](#failed-channels) |
| `Pending rechecks` | Threads whose inline images are still waiting for a recheck. A thread that reached the five-attempt cap is not counted |

A run that wrote no index does not change `Last snapshot`. Below the table, warnings name damaged channel cursors and threads that failed in a previous run. A damaged snapshot index, or an object written by a newer Atlas format, is named after them and makes the command exit `9`.

### delete

Deletes every Teams backup for one team, or one snapshot.

| Option                | Description                                        |
| --------------------- | -------------------------------------------------- |
| `--team <id>`         | Team ID (required)                                 |
| `-s, --snapshot <id>` | Delete only this snapshot's index                  |
| `-y, --yes`           | Skip the confirmation prompt                       |
| `-t, --tenant <id>`   | Override the tenant ID from config                 |

```bash
atlas teams delete --team <team-id>
atlas teams delete --team <team-id> -s <snapshot-id>
```

A full delete removes, in order, the channel cursors, snapshot indexes, channel shards, then message and image objects, and finally the quarantined copies of the team's indexes. With `-s`, only that snapshot's index is deleted. Its shards and messages stay, because later snapshots can reference them.

::: danger Irreversible
Deletion cannot be undone. Objects under Object Lock retention stay until the retention period ends. Atlas cannot erase one person's messages from a team backup; see [Erasure](/security#erasure).
:::

### quarantine

Moves an unreadable snapshot index to `_quarantine/` so later runs stop reporting it. See [Unreadable snapshots](#unreadable-snapshots).

```bash
atlas teams quarantine --key teams/manifests/<team-id>/<snapshot-id>.json
```

| Option                | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| `--key <storage-key>` | Storage key a command reported as unreadable (required)     |
| `-t, --tenant <id>`   | Override the tenant ID from config                          |

## Reading the result

Each backup ends with `Status: HEALTHY` or `Status: UNHEALTHY`.

| Exit | Meaning                                                                                                     | What to do                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `0`  | Every channel completed                                                                                     | Nothing                                                          |
| `2`  | A team is unhealthy: a channel error, a failed thread still listed, an interrupted run, or only foreign channels | Read the report. See [Failed channels](#failed-channels)         |
| `4`  | Authentication error on a team's first channel. The run stops                                               | Fix consent or credentials                                       |
| `9`  | The only finding is a damaged snapshot index, or a newer-format object                                      | Run the printed `atlas teams quarantine` command, or upgrade Atlas |

A channel error is recorded and the next channel still runs. With several teams, a team that fails with an error other than an authentication error is recorded and the other teams still run. A single `--team` run stops on its first error and exits with that error's category code. See [Exit codes](/reference/cli#exit-codes) for the full list.

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

## How incremental backup works

Each channel keeps its own sync checkpoint (a Microsoft Graph delta link). A run asks Microsoft 365 for the threads that changed since the last run, and a new reply, reaction, edit, or deletion returns the whole thread. Atlas stores each message version once, so an unchanged message or channel reuses what is already in storage. Atlas writes the snapshot index first, then saves each channel's new checkpoint. A channel that fails keeps its previous checkpoint, so its changes are read again next run.

::: warning Incremental reads cover eight months
Microsoft Graph returns incremental changes only for messages from the last eight months. A first run or a `--full` run reads older messages too.
:::

A channel is read in full instead of incrementally when:

- it is a first run, or `--full` is passed;
- the channel has no channel email address;
- Microsoft Graph rejects the saved checkpoint with `400` (logged as a warning);
- the checkpoint does not match the latest readable snapshot, or cannot be read (logged as a warning).

The channel is then recorded with `read_mode: full`. A `--full` run fetches every thread again but never rewrites a message already in storage.

::: details How Atlas reads a channel
A thread that a full read does not list is not marked removed on that evidence alone. The listing is paged newest first, so a thread posted or deleted while Atlas pages it shifts later pages, and a live thread can land on no page. After the listing, Atlas reads each live stored thread it did not list by ID. Only a `404` marks it removed. A thread Microsoft Graph still returns is stored as it comes back, live or deleted with Graph's `deletedDateTime`. Any other error keeps the thread live and adds it to the list of failed threads. This costs one request per unlisted thread, plus a reply listing for one that turns out to be live. A full read that lists every stored thread makes no extra requests.

A thread's `lastModifiedDateTime` and `etag` do not change for reply activity, so Atlas reads the thread and its replies whenever the incremental read returns it.

A saved checkpoint is used only when its cursor's `baseline_shard_key` equals the shard the latest readable index lists for that channel. Otherwise only that channel is read in full.

The channel listing asks for 50 threads per page with replies included. When the reply list is incomplete, Atlas pages the rest through `/replies`. A thread retried from the failed list is read alone, with its replies from `/replies`.
:::

## Stopping and resuming a run

Ctrl+C stops the run and exits `2`. Threads already stored are kept. The thread in flight is not recorded as a failure, and the request in flight still completes on Microsoft's side, with its result dropped. The interrupted channel keeps its previous sync checkpoint and its read progress, so the next run resumes it. Channels not reached carry forward unchanged.

Ctrl+C during the team and channel lookups ends the run before any channel is read, with `Status: UNHEALTHY` and exit `2`. A second Ctrl+C exits at once with status `130`. Nothing from that run is referenced: the index is not written, no checkpoint moves, and objects already uploaded stay in storage unreferenced.

### Resuming an interrupted backup

A channel's read saves its progress after every page of 50 threads, encrypted, under `_meta/{team_id}/checkpoints/{channel_id}/`. If a run stops partway through a channel, by Ctrl+C or a crash, the next run continues from the last saved page. Inline images already stored are not downloaded again.

::: tip
A crash can repeat the page that was in flight. Its Microsoft Graph reads run again, but its content is not stored twice and its images are not downloaded twice.
:::

| Situation                                                          | What Atlas does                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Saved progress matches the run's baseline and sync checkpoint       | Resumes                                                                           |
| A `--full` run finds progress from an incremental read              | Starts the channel from the beginning                                             |
| An incremental run finds progress from a full read                  | Resumes it. A rejected checkpoint leaves this behind                              |
| Saved progress does not match, or cannot be read                    | Deletes it with a warning and starts the channel from the beginning               |
| Saved progress written by a newer Atlas format                      | Keeps it. The team's backup stops with exit `9` (`ATLAS_FORMAT_UNSUPPORTED`) until you upgrade |

Read progress is written without the run's Object Lock retention (`--retention-days`), because it is rewritten after every page and deleted when the read finishes. When a channel's read finishes, Atlas saves its sync checkpoint, then deletes the progress. Failed threads stay listed and are retried on the next run.

::: details Image journal
Each inline image is journaled as its own small encrypted object under `hosted/` in the checkpoint folder, written just before the image itself. A resumed run reuses every journaled image already in storage and downloads only images that never reached storage. A channel with thousands of images writes one journal object per image and one progress record per page.
:::

## When a channel cannot be backed up {#failed-channels}

A channel that cannot be read is recorded as an error, and the run continues with the next channel. So is a channel the previous snapshot holds that the channel listing left out while Microsoft Graph still returns it by ID: its previous entry is kept unchanged rather than marked deleted. Teams under `--all` or repeated `--team` are isolated the same way. A Microsoft Graph outage is the exception: once a call spends its retry budget, the run starts no other channel and no other team, and exits `3`. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).

A thread that fails is added to its channel's list of failed threads and retried on later runs:

| Situation                                                | What Atlas does                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A thread fails                                           | Reported as a channel error with `will retry (attempt N of 5)`. Retried each run, even if no change is reported      |
| A thread fails five times                                | Reported as `PERMANENTLY SKIPPED after 5 attempts`. No longer retried, so the channel's checkpoint can advance       |
| Microsoft Graph answers `400` for its replies or re-read | Reported as `PERMANENTLY SKIPPED by service policy, not retried` on the first failure                                |
| Microsoft Graph answers `404` on a re-read               | Kept as previously stored, reported as a warning, and counted as an attempt                                         |
| A thread is processed cleanly                            | Removed from the list                                                                                               |

While any thread remains on the list, including a `PERMANENTLY SKIPPED` one, the run reports `Status: UNHEALTHY` and exits `2`, even when that run had no channel error. To clear it, see [Permanently skipped threads](#permanently-skipped-roots).

Missing inline images are handled more gently. A thread whose inline image Microsoft Graph did not return, or returned with `404` or `403`, is rechecked on later runs with the warning `hosted content still missing (attempt N of 5); re-checking next run`. After the fifth attempt Atlas warns once that it gave up, and incremental runs stop rechecking that thread. A full read still lists it and applies it again. These are warnings only: a run with nothing else wrong still prints `Status: HEALTHY`.

## Recovery

### Permanently skipped threads {#permanently-skipped-roots}

A permanently skipped thread keeps the team unhealthy. Check the error in the report first, then read the channel again in full:

```bash
atlas teams backup --team <team-id> --channel <channel-id> --full
```

A full read processes every thread Microsoft Graph returns for the channel, so a thread that now succeeds is cleared from the list. A thread Graph no longer lists is cleared and read by ID: a `404` marks it removed.

### Unreadable snapshots

```bash
atlas teams status                       # names the damaged key, exits 9
atlas teams quarantine --key teams/manifests/<team-id>/<snapshot-id>.json
```

A snapshot index is unreadable when it cannot be decrypted or parsed, when its team or snapshot ID does not match its key, or when its `created_at` is not a valid timestamp.

| Command                                   | What it does with an unreadable index                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `status`, `list-snapshots`                | Skips it, names its key with the `atlas teams quarantine` command, exits `9` (`ATLAS_CONTENT_UNREADABLE`)                  |
| `backup`, index newer than the latest readable one | Same, and warns that its baseline is an older snapshot. A channel failure in the same run keeps exit `2`; the key is still named |
| `backup`, team fails after reading indexes | Names the key. The failure's own exit code applies                                                                         |
| `backup`, no readable index at all         | Warns `No readable snapshot exists; every channel is read in full`                                                        |

The last case can follow a bucket wipe that Object Lock partly blocked, which leaves legacy manifests behind.

`quarantine` moves the damaged index to `_quarantine/` with its bytes unchanged, so later commands stop reporting it. It refuses an index that reads cleanly. The snapshot's shards and messages stay in storage. The next backup compares against the newest readable index, which is older. Each channel whose checkpoint no longer matches that index is read in full, so no `--full` run is needed. See [Damaged manifests](/reference/cli#damaged-manifests-and-version-indexes) for the refusals and Object Lock behaviour.

An index with a higher `format_version` is intact, so `quarantine` refuses it. `status` and `list-snapshots` name it, say to upgrade Atlas, and exit `9` (`ATLAS_FORMAT_UNSUPPORTED`). If it is newer than the latest readable index, the backup refuses to write for that team until Atlas is upgraded, also with exit `9`, so it never overwrites the index or treats it as absent.

A damaged channel cursor is not quarantined. `status` names it in a warning, and the next backup reads that channel in full and rewrites the cursor.

### Unreadable channel shards

```bash
atlas teams backup --team <team-id> --channel <channel-id> --full
```

A channel shard holds one channel's threads for a snapshot. It is unreadable when it is missing, cannot be decrypted or parsed, or does not match the team, channel, and content name in its key. Shards are not quarantined.

- **Without `--full`.** The backup needs the shard as its baseline, so it fails that channel, keeps the channel's previous index entry, and exits `2`. The channel error names the shard's key and the command above.
- **With `--full`.** Atlas warns with the shard's key, reads the channel from Microsoft 365 as if it had no previous shard, and writes a new shard and index entry. If the rebuilt shard has the same content and nothing else changed, the run writes no new snapshot, prints `Repaired N unreadable channel shard(s) in place; no new snapshot needed.`, and exits `0`.

::: warning What a rebuild cannot recover
The new shard holds what Microsoft 365 returns in that run. Threads that only the unreadable shard recorded, such as threads already removed from Teams, are not carried forward. They remain in older snapshots whose shards are intact. A snapshot that names the unreadable shard stays unreadable for that channel unless the rebuilt shard has the same content.
:::

A storage error while loading the shard is not treated as damage: the channel fails with the storage error, and `--full` does not rebuild it. A shard written by a newer Atlas format is never rebuilt or overwritten. It stops the team's backup with exit `9` (`ATLAS_FORMAT_UNSUPPORTED`), also under `--full`.

### Files folder

Atlas reuses each channel's files folder result from the previous run, including an unavailable one. After granting `Files.Read.All`, look it up again with a full read:

```bash
atlas teams backup --team <team-id> --full
```

## Pacing

Microsoft meters Teams reads per application per tenant, and again per team and per channel. Atlas spaces its requests at 80 % of each published limit, so Microsoft Graph rarely has to throttle them:

| Scope   | Requests                                        | Paced at       |
| ------- | ----------------------------------------------- | -------------- |
| Tenant  | Channel messages, replies, and inline images    | 16 per second  |
| Tenant  | Team, members, channels, tabs, and files folder | 24 per second  |
| Team    | Team, members, channels, tabs, and files folder | 3.2 per second |
| Channel | Channel messages, replies, and inline images    | 0.8 per second |

Every request in one Atlas process shares these budgets, including requests from several teams backed up at once. The remaining 20 % leaves room for other applications and for Microsoft's sustained window, which is evaluated below the listed rate. Teams requests use their own throttling pool, separate from OneDrive and SharePoint; see [Graph rate limits](/operations/graph-rate-limits#teams-pool).

When Microsoft 365 throttles one team (`429`), only that team pauses, for the `Retry-After` Graph sends. Other teams of the tenant keep running. See [Throttle handling](/operations/graph-rate-limits#throttle-handling).

A first backup reads every message once, so its duration follows from the channel budget: 0.8 requests per second per channel, each returning up to 50 threads with their replies. To use the tenant budget, back up several teams at once. With the default four channels per team, five teams in parallel reach the 16 requests per second the tenant allows.

## Restore

Atlas does not restore messages into Teams. To recover channel content, export a snapshot with [`save`](#save) and open `index.html`, or read `messages.json`.

Microsoft's only way to write past messages into a channel is the [Teams message import API](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/import-messages/import-external-messages-to-teams). Atlas does not use it:

- **Permission.** The import API needs `Teamwork.Migrate.All`, which lets the application post messages as any user, with any past timestamp, into any channel of the tenant. A backup application holding it turns a stolen client secret into a way to forge conversation history. Atlas keeps its Teams permissions read-only.
- **No undo.** Imported messages are new messages. Microsoft's only correction for a wrong import is to delete the team and import again.
- **No merge.** Microsoft Graph cannot overwrite a message by ID, so importing into a channel that still holds messages duplicates them. Edit history, deletions, and messages from other tenants cannot be imported.

The snapshot keeps the original message objects, inline images with their content type, members, and tabs, so a later release can add an import path without a new backup.

## Storage layout

Teams objects live under the `teams/` prefix of the tenant bucket, every one of them encrypted. See [Storage layout](/operations/storage-layout).

```text
teams/
  data/{team_id}/{content_name}                        message and reply versions
  data/{team_id}/hosted/{content_name}                 inline images
  manifests/{team_id}/{snapshot_id}.json               snapshot indexes
  shards/{team_id}/{channel_id}/{content_name}.json    channel shards
  _meta/{team_id}/channels/{channel_id}.json           channel cursors
  _meta/{team_id}/checkpoints/{channel_id}/            read progress (head, segments, hosted/ journal)
```

`content_name` is a keyed HMAC of the content, so it does not match a plain SHA-256. See [What object names reveal](/security#what-object-names-reveal).

Snapshot indexes, channel shards, and channel cursors carry `format_version: 1`. An object whose `format_version` is missing or not `1` is unreadable, and one with a higher version is refused with an error that names its key and says to upgrade Atlas.

## Limits

- **Not covered:** 1:1, group, and meeting chats, and channel file content. See [What is not backed up](#what-is-not-backed-up).
- **Restore:** messages are not written back into Teams. See [Restore](#restore).
- **Erasure:** one person's messages cannot be erased without removing the whole team's backup. See [Erasure](/security#erasure).
- **Throttling:** Teams calls are paced per tenant, team, and channel. See [Pacing](#pacing).
- **Known gaps in the current format:**
  - A reply that Microsoft Graph stops listing without a deletion notice is carried over as live.
  - A reply that Microsoft Graph deletes before Atlas has listed it is not stored.
  - `verify` checks a channel shard by decrypting it, not against its checksum in the index.

## SDK usage

The SDK exposes the same operations on `atlas.teams`. Options and results use camelCase. `backup` takes one team per call and returns one result; the CLI loops over `--team` and `--all`.

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

`backup` accepts `concurrency`, the number of channels backed up at once (1 to 16, default 4). The result's `summary` reports:

| Field                                  | Content                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `elapsedMs`                            | Run duration                                                                                  |
| `channels`                             | One entry per channel: `channelId`, `outcome`, `readMode`, `rootsApplied`, `resumedFromCheckpoint`, `elapsedMs` |
| `requests.messages`, `requests.default` | `requests`, `throttled`, and `achievedRps` per limit class                                   |

Each `processing` progress event names the channel that finished in `current` and carries `etaMs`, an estimate of the time left based on the channels finished so far. See the [SDK reference](/reference/sdk) for every method and field.

A backup, deletion, or quarantine holds the team, so Atlas runs one such operation at a time per team. A second one rejects with `OwnerBusyError` (`ATLAS_OWNER_BUSY`) and writes nothing.

### Many teams and several processes

To back up many teams, run several `backup` calls at once, one per team. All calls on one Atlas instance share the pacing budgets above. When several processes back up one tenant:

- Give them a shared `throttleCoordinator`. For `teams` requests its `wait` and `raise` receive the team ID as `scope.ownerId`, so a cooldown applies to one team.
- Set `teamsPacingShare` on each instance to its share of the tenant budget, for example `0.25` for four processes. Pacing state lives in each process, so without it four processes would together send up to four times the tenant rate. Team and channel budgets stay whole.
- Schedule one operation per team at a time. Atlas refuses the second with `OwnerBusyError`, so an overlap costs a failed run rather than a lost checkpoint, and the refused run can be retried after `lease_expires_at`.

See [Concurrent operations](/reference/sdk#concurrent-operations).

## See also

- [CLI reference](/reference/cli#atlas-teams)
- [Programmatic SDK](/reference/sdk)
- [Azure AD setup](/azure-ad-setup)
- [SharePoint backup](/sharepoint-backup)
- [Security](/security)
