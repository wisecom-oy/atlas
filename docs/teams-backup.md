---
description: 'Back up Microsoft Teams channel messages, replies, members, and tabs incrementally through Microsoft Graph, with every blob encrypted before it reaches storage.'
---

# Teams backup

Atlas backs up the channels of Microsoft Teams teams. It stores channel messages with their replies, edits, deletions, and inline images, plus team settings, members, channels, and tabs. Each channel keeps its own delta cursor, so a later run reads only the threads that changed.

Backup and verification are available. Restore and save are not yet available. Atlas stores the raw Graph objects, so a later release can restore them.

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
```

::: warning Protected API
Channel messages are read with `ChannelMessage.Read.All`, a protected Microsoft Graph permission. Microsoft may need to approve it for your tenant before backups succeed. See [Azure AD setup](/azure-ad-setup#teams-application-permissions).
:::

## What is backed up

| Item                                   | Coverage                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Channel messages                       | Every root message in each channel the team hosts, including private channels                                             |
| Replies                                | Stored with their root in one thread blob. A deleted reply is marked `deletedDateTime`; `last_live` keeps its last text   |
| Reactions, mentions, edits             | Kept in the raw Graph objects, as Graph returned them. `lastEditedDateTime` shows the last edit                           |
| Inline images                          | Stored as encrypted bytes. The image URLs in each message are kept                                                        |
| System messages                        | Stored with their thread, as Graph returns them                                                                           |
| File attachments                       | Recorded as links. Atlas does not download them. Files live in SharePoint; see [Team files](#team-files)                  |
| Team settings, members, channels, tabs | Raw Graph objects                                                                                                         |

Channels owned by another tenant are skipped with the warning `Channel <id> is owned by another tenant; skipped`.

Earlier versions of an edited or deleted message survive in the thread blobs of the snapshots that recorded them.

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

Backs up one or more teams. Pass `--team` once per team, or `--all` for every team in the tenant. `--channel <id>` backs up only that channel, needs exactly one `--team`, and cannot be combined with `--all`. Other channels carry forward from the previous manifest.

```bash
atlas teams backup --team <team-id>
atlas teams backup --team <team-id> --team <other-team-id>
atlas teams backup --all
atlas teams backup --team <team-id> --channel <channel-id>
```

Each team runs independently and is reported when it finishes. A channel error is recorded, and the next channel still runs. With several teams, a team that fails with an error other than an authentication error is recorded, and the other teams still run. The run exits `2` when any team is unhealthy: a channel error, a ledger root still listed, or an interrupted run. A single `--team` run stops on its first error and exits with that error's category code. An authentication error on a team's first channel also stops the run, with exit `4`. See [Failed channels](#failed-channels). The full option list is in the [CLI reference](/reference/cli#atlas-teams).

### list-snapshots

Lists the snapshots stored for one team, newest first. A manifest Atlas cannot read is named in a warning with its storage key, and the rest of the list still prints. See [Unreadable snapshots](#unreadable-snapshots).

```bash
atlas teams list-snapshots --team <team-id>
```

### verify

Checks that every blob a snapshot references is present and matches its SHA-256 digest.

```bash
atlas teams verify --team <team-id> -s <snapshot-id>
```

### status

Shows, for each team with a snapshot, the newest snapshot's creation time (`Last snapshot`) and ID. A run that wrote no manifest does not change it.

```bash
atlas teams status
```

### delete

Deletes every Teams backup for one team: its manifests, thread and image blobs, and delta cursors. With `-s`, it deletes only that snapshot's manifest. Its blobs stay, because later snapshots can reference them. `-s` removes the manifest by key without reading it, so it also removes a snapshot that `list-snapshots` cannot read. Atlas asks for confirmation unless you pass `-y`.

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
2. **Thread refetch.** For each returned root, Atlas reads the full reply list and rebuilds the thread blob. Replies arrive inline through `$expand=replies`. When Graph truncates that list, Atlas pages the replies through `/replies`.
3. **Deduplication.** Atlas hashes the thread blob. An unchanged thread is not uploaded again. A forced full read (`--full`) fetches every thread again but never rewrites a blob that already exists, because each blob's name is derived from its content.
4. **Cursor commit.** Atlas saves the new delta link once the manifest for the run is written. A channel that fails keeps its previous link, so its changes are read again next run.

When nothing changed, Atlas writes no manifest. A healthy run prints `No Teams changes detected. Snapshot skipped.` The delta cursor is still saved.

A channel is read in full, with no delta link, when it has no channel email address, when no link is stored (a first run, or `--full`), or when Graph rejects the saved link with `400`. A `400` logs a warning and falls back to a full read. The channel is recorded with `read_mode: full` in the manifest. A saved cursor is used only when its `snapshot_id` matches the latest readable manifest. A mismatch, a cursor from an older release without `snapshot_id`, or an unreadable cursor means every channel is read in full, with a warning.

Deleted messages and channels are carried forward, not dropped. A root that Graph reports as deleted, or that a full read no longer returns, is recorded with `deleted_at` set. Later snapshots keep it, and its blobs stay in place. A channel the team no longer lists keeps `deleted_at` in later manifests.

Ctrl+C stops the run. Atlas stops waiting on the request in flight, but Graph has no cancel, so that request still completes on Graph's side and its result is dropped. The root it belonged to is recorded as a failed attempt. Threads already stored are kept. The interrupted channel keeps its previous delta link, so its changes are read again next run, and channels not reached carry forward unchanged. Ctrl+C during the team and channel lookups is honored when the channel loop starts. The run then prints `Status: UNHEALTHY` and exits `2`.

## Storage layout

Teams objects live under the `teams/` prefix of the tenant bucket.

```
teams/
  data/{team_id}/{content_name}            encrypted thread blobs
  data/{team_id}/hosted/{content_name}     encrypted inline images
  manifests/{team_id}/{snapshot_id}.json   encrypted snapshot manifests
  _meta/{team_id}/delta.json               encrypted delta links per channel
```

`content_name` is the keyed name Atlas uses for every content object. It is an HMAC, so it does not match a plain SHA-256 of the content. See [What object names reveal](/security#what-object-names-reveal).

Manifests and delta cursors carry `format_version: 1`. An object without the field is read as the original layout. An object with a higher version is refused with an error that names its key and says to upgrade Atlas.

## Failed channels

If a channel cannot be read, the run records the error and continues with the next channel. Teams under `--all` or repeated `--team` are isolated the same way.

A thread root that fails is kept in a ledger keyed by channel and root (`channel_id/root_id`), stored with the delta cursor. Each run re-fetches ledger roots that the delta read did not return, until the root has failed five times. The report shows `will retry (attempt N of 5)`. After the fifth failure it shows `PERMANENTLY SKIPPED after 5 attempts`, and Atlas stops re-fetching that root, so the channel's delta link can advance. The entry stays in the ledger until a read processes the root cleanly.

Each failed attempt is reported as a channel error. While any ledger entry remains, including a `PERMANENTLY SKIPPED` one, the run reports `Status: UNHEALTHY` and exits `2`, even when that run raised no channel error.

```bash
status=0
atlas teams backup --all || status=$?
if [ "$status" -eq 2 ]; then
  echo "Some channels failed. Review the report before relying on this run." >&2
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

A full read processes every root Graph returns for the channel, so a root that now succeeds clears its entry. A root that Graph no longer lists is marked removed, and its entry is cleared.

### Unreadable snapshots

`list-snapshots` skips a manifest it cannot read and names its storage key in a warning. A manifest is unreadable when its `format_version` is higher than this Atlas reads, or when its team, snapshot, or `created_at` does not match its key.

- If the warning names a newer `format_version`, upgrade Atlas.
- Otherwise the manifest is damaged. Delete it by snapshot ID. The snapshot ID is the last segment of the key, without `.json`.

```bash
atlas teams delete --team <team-id> -s <snapshot-id>
```

`-s` removes the manifest by key without reading it. The snapshot's blobs stay in storage. The saved delta cursors then point at a snapshot that is no longer the latest readable one, so the next run reads every channel in full, as described in [How a run finds changes](#how-a-run-finds-changes).

### Files folder

Atlas keeps each channel's files folder result from the previous run, including an unavailable one. A forced full read is what looks it up again. After granting `Files.Read.All`, run:

```bash
atlas teams backup --team <team-id> --full
```

Without `--full`, the cached result stays in place.

## Limits

- **Not covered:** 1:1 chats, group chats, and meeting chats. These belong to individual users and carry separate legal and retention duties. Atlas does not use the metered bulk-export API for them.
- **Restore and save:** not available yet.
- **Throttling:** Teams calls use their own throttle pool, separate from OneDrive and SharePoint. Limits are in [Graph rate limits](/operations/graph-rate-limits#teams-pool).
- **Replication:** Teams snapshots cannot be replicated or rehydrated yet. Those calls refuse `teams-snap-*` IDs with `Teams snapshots are not replicated yet`.

## SDK usage

The SDK exposes the same operations on `atlas.teams`. Options and results use camelCase. `backup` takes one team per call and returns one result. The CLI loops over `--team` and `--all`. Never run two operations on one team at once. See [Concurrent operations](/reference/sdk#concurrent-operations).

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
