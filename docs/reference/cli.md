---
description: 'Flag-by-flag reference for the Atlas CLI (@wisecom/atlas-cli): every command, option, and exit code, for shell scripts and cron jobs.'
---

# CLI commands

The Atlas CLI (`@wisecom/atlas-cli`) runs backup, restore, verification, and storage operations from a shell. It suits cron jobs, operator workflows, and simple deployments. Credentials come from `.env`, environment variables, or the encrypted store that `atlas config` and `atlas tenants` write (see [Configuration](/configuration)).

For Node.js applications such as custom schedulers and multi-tenant services, use the [Programmatic SDK](/reference/sdk). It takes explicit config at construction time, with no `.env` dependency, and exposes the same operations as typed methods. For the order in which to run `verify`, `restore`, `save`, and `delete` during an incident, see [Recovery workflows](/reference/cli-recovery).

## Installation

```bash
npm install -g @wisecom/atlas-cli
atlas --version
```

A postinstall hook puts the `atlas` command on your PATH. It never fails the install.

| Situation                                                | What happens                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Local install                                            | The hook links `atlas` into `/usr/local/bin` or `~/.local/bin`                                                |
| Global install                                           | The hook replaces an older Atlas command, so `atlas --version` reports the version you just installed         |
| `atlas` is already a shell alias or another command      | The hook skips with a warning and leaves it alone. Use `npx atlas`                                            |
| `ATLAS_SKIP_POSTINSTALL=1` is set                        | The hook does nothing. Link manually with `npm run link-cli --prefix node_modules/@wisecom/atlas-cli`         |
| pnpm                                                     | Dependency lifecycle scripts are blocked by default. Run `pnpm approve-builds`                                |
| Bun                                                      | Dependency lifecycle scripts are blocked by default. Run `bun pm -g trust @wisecom/atlas-cli`                 |
| Windows                                                  | Global installs use npm's `.cmd` shims                                                                        |

An explicit `link-cli` run, including `pnpm run link-cli` in a source checkout, takes the `atlas` command over from any other Atlas install. Reinstall the other package to point it back.

## Output width

```bash
COLUMNS=200 atlas sharepoint list-sites > sites.txt
```

Tables are laid out for the terminal width. When output is piped or redirected, Atlas assumes 80 columns, so long values such as site URLs and object IDs wrap onto a second line, and a script that greps for an ID or parses the output misses the wrapped value. Set `COLUMNS` to keep each row on one line.

## Exit codes

Scripts should branch on the exit code, not on the message text:

```bash
status=0
atlas outlook backup --mailbox "$mailbox" || status=$?
case "$status" in
  0) echo "Complete" ;;
  2) echo "Incomplete run: inspect the reported items" >&2 ;;
  3) echo "Transient failure: schedule a later attempt" >&2 ;;
  4|5|6|7|8|9|10|11) echo "Operator action required; do not retry unchanged" >&2 ;;
  12) echo "Another operation holds this mailbox, owner, site or team: retry later" >&2 ;;
  *) echo "Command failed; inspect stderr" >&2 ;;
esac
exit "$status"
```

| Code | Meaning                                                                       | What to do                                                  |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `0`  | Success, help, or a command with no failure reported                          | Continue                                                    |
| `1`  | Unclassified failure, invalid usage, or `ATLAS_WRITE_REFUSED`                 | Read stderr. Do not assume it is transient                  |
| `2`  | Partial run: items failed or were skipped, or a soft interrupt                | Inspect the partial result before relying on it             |
| `3`  | `ATLAS_THROTTLED` or `ATLAS_GRAPH_UNAVAILABLE` after the retry budget         | Schedule a later attempt                                    |
| `4`  | `ATLAS_AUTH_DENIED`, `ATLAS_MAILBOX_NOT_LICENSED`, or `ATLAS_ACCESS_REFUSED`  | Fix credentials, permissions, admin consent, or licensing   |
| `5`  | `ATLAS_WRONG_PASSPHRASE`: the data key would not unwrap                       | Supply the original tenant passphrase                       |
| `6`  | `ATLAS_CONFIG_INVALID`                                                        | Correct the configuration or its storage access             |
| `7`  | `ATLAS_NOT_FOUND`, or a selector that matched nothing                         | Check the resource, identifiers, and selectors              |
| `8`  | `ATLAS_OBJECT_LOCK_RETAINED`                                                  | Respect the retention or legal hold                         |
| `9`  | `ATLAS_CONTENT_UNREADABLE`, `ATLAS_FORMAT_UNSUPPORTED`, or a damaged manifest | Do not retry unchanged. See the notes below                 |
| `10` | Unassigned                                                                    | Not returned                                                |
| `11` | `ATLAS_SNAPSHOT_NOT_NEWEST`                                                   | Delete the newer snapshots first, or the whole backup       |
| `12` | `ATLAS_OWNER_BUSY`: another operation holds the owner or tenant               | Retry once the other operation ends                         |

What each code covers:

- **`1`** also covers a command-reported failure without a typed exception: a failed verification, `storage-check` reporting an unready bucket, and `config validate` reporting a failed probe. `ATLAS_WRITE_REFUSED` means Atlas refused to store a manifest, index, or cursor it built; see [Refused and unconfirmed metadata writes](/troubleshooting#refused-and-unconfirmed-metadata-writes).
- **`2`** covers item errors, skipped files, integrity failures, a soft interrupt (first Ctrl+C), a `--folder` or `--file-filter` value that matched nothing while others matched, a `keys rewrap` that left a tenant under the old passphrase, and a `keys purge-old-wrappers` that left an old wrapper. Per-item failures already reported as partial stay `2`, and their messages are not reclassified.
- **`3`** means Microsoft Graph kept answering `429`, `500`, `502`, `503`, `504`, or a network error through the retry budget, or the command met an unwrapped transient status or recognized network error. For `ATLAS_GRAPH_UNAVAILABLE`, check Microsoft 365 service health first. A Graph token request that Microsoft Entra ID leaves unanswered, or answers with `408`, `429`, a `5xx`, or `temporarily_unavailable`, is retried the same way and also ends in `ATLAS_GRAPH_UNAVAILABLE`. A timeout does not prove a write was never committed, so inspect partial work before repeating a restore.
- **`4`** also covers an unwrapped HTTP `401` or `403`. A Graph token request that Microsoft Entra ID refuses also exits `4` with `ATLAS_AUTH_DENIED`: a wrong or expired client secret, an unknown client ID, or a tenant that does not exist. Entra's answer, including its AADSTS code, is printed as the cause. See [AADSTS error codes](/troubleshooting#aadsts-error-codes). `ATLAS_ACCESS_REFUSED` means Graph refused one site, drive, or owner and Atlas did not attribute it to a missing grant, as with a SharePoint Embedded container. Retrying returns the same answer: leave a container out of the run, and check the per-site grant of an ordinary site. See [SharePoint: site refused while the root site is readable](/troubleshooting#sharepoint-site-refused-while-the-root-site-is-readable).
- **`5`**: never pad the passphrase or delete the wrapped key. If the passphrase is correct, investigate possible corruption.
- **`6`** includes failure to load the CLI configuration, and a partial `ATLAS_*` Graph override that changes the selected profile's tenant or client ID.
- **`7`** includes an unwrapped HTTP `404`, and a `--folder`, `--file-filter`, or `--message` selection that matched nothing.
- **`8`** means storage refused to remove an object because of retention or a legal hold. The `quarantine` commands return it when the original cannot be removed, and a Teams `backup` returns it when the backend refuses to delete a finished channel checkpoint. A `delete` that meets retained objects reports them as retained and exits `1`.
- **`9`** means the stored bytes cannot be parsed back, or were written by a newer Atlas format. Repeating the command will not help. For a newer format, upgrade Atlas. For a named manifest or version index, see [Damaged manifests and version indexes](#damaged-manifests-and-version-indexes). Otherwise extract the raw content with `save`.
- **`10`** is reserved and not returned.
- **`11`**: `outlook delete -s`, `onedrive delete -s`, or `sharepoint delete -s` named a snapshot that newer snapshots of the same mailbox, owner, or site are built on. Delete the newer snapshots first, newest first, or delete the whole backup of that mailbox, owner, or site by leaving out `-s`.
- **`12`**: another backup, restore, deletion, or quarantine holds the lease on the same mailbox, drive owner, site, or team, a purge or key re-wrap holds the tenant, or this run lost its lease before it could commit. Nothing was committed. If the other process was killed, its lease expires 5 minutes after its last renewal, and the message names that time. See [Another operation holds the owner](/troubleshooting#another-operation-holds-the-owner).

How failures are classified:

- An explicit Atlas category takes precedence over transport details. Unwrapped HTTP `401`, `403`, `404`, and `429` responses also receive their Atlas category.
- `StorageError` (`ATLAS_STORAGE_FAILURE`) exits by its cause: `4` for a `401` or `403`, `7` for a `404`, `3` for a network error or a transient status, and `1` otherwise.
- Network detection reads structured Node error codes, including a nested `cause`, never message text. An error that only says "socket hang up" is unclassified unless it carries a recognized code.
- A process killed by a signal may appear as `128 + signal` in the shell, such as `130` after a second Ctrl+C. That is separate from these categories.

A confirmation prompt that ends without an answer exits `1` and changes nothing. That covers stdin at EOF, as under cron or systemd with stdin on `/dev/null`, and Ctrl+C or Ctrl+D pressed at the prompt. Answering `n` is a decision, not a failure, and exits `0`. Scheduled jobs pass `-y` to skip the prompt.

[Retries and fail-safes](/operations/reliability#exit-codes-and-whether-to-retry) explains which codes a rerun can fix and what Atlas retried before giving up.

### Backup, restore, and save results

These rules apply to Outlook, Contacts, Calendar, OneDrive, and SharePoint. Teams adds its own, listed under [`atlas teams backup`](#atlas-teams-backup) and [`atlas teams save`](#atlas-teams-save).

| Result                                                | Exit | Notes                                                                                     |
| ----------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| Complete, no errors                                   | `0`  |                                                                                           |
| Per-folder or per-file errors                         | `2`  | Failed items are listed on stderr                                                         |
| Run prints `Status: UNHEALTHY`                        | `2`  | Unless the only finding is a damaged manifest or index, see below                         |
| Only finding is a damaged snapshot manifest or index  | `9`  | OneDrive, SharePoint, Teams, Calendar, and Contacts print `Status: UNHEALTHY` and name it |
| A restore or save skipped a file                      | `2`  | An archive or restore missing some files is not a success                                 |
| Integrity failure                                     | `2`  | Content did not match its manifest checksum                                               |
| First Ctrl+C                                          | `2`  | Soft interrupt, see [Stopping a run](#stopping-a-run)                                     |
| Second Ctrl+C                                         | `130`| Immediate exit, no final report                                                           |

- **Exit `2` does not prove a snapshot was saved.** An interrupted Contacts or Calendar backup saves none, and a Contacts or Calendar run whose only changes failed has nothing new to save. Check the run output, `atlas contacts list`, or `atlas calendar list` for the snapshot.
- **Unhealthy runs without new errors.** A Calendar run with no event errors that left attachments out (item and reference attachments, or attachments on a single exception of a series) prints `Status: UNHEALTHY`; see [Attachments](/calendar-backup#attachments). So does a OneDrive, SharePoint, or Teams run with no new errors while a file is still in the list of failed files, waiting for a retry or permanently skipped after 5 attempts. Those files are listed as warnings, and the run is not complete until the list is empty.
- **Skipped files.** `restore`, `restore-version`, and `save` count a file they cannot read, decrypt, verify, or write as skipped, and any skipped file exits `2`. That includes failures unrelated to the backup, such as a folder Graph would not create or an upload it refused, so a cron job that only checks for `0` sees the difference.
- **A damaged stored object fails only its own file.** When a OneDrive or SharePoint `restore` or `restore-version` reads an object that is missing, fails AES-GCM authentication, or decrypts to content that does not match its SHA-256 checksum, it names the file and the reason, writes nothing for that file, restores the rest, and exits `2`. `save` and `verify` report the same files. A wrong passphrase is reported differently: the data key does not unwrap, so the run stops with exit `5` before it reads the snapshot or writes anything. See [Authentication failure on an object](/troubleshooting#authentication-failure-on-an-object).
- **Integrity failure.** A message whose decrypted bytes do not match its manifest checksum is still written, but it can no longer be confirmed as the backed-up content. The ciphertext decrypted correctly, so the manifest or the object was replaced. Run [`atlas outlook verify`](#atlas-outlook-verify) to find the scope before trusting the archive.

#### Stopping a run

The first Ctrl+C is a soft interrupt. It covers every backup, every restore including `restore-version`, and `atlas outlook save`:

- The Graph request in flight and any retry backoff or throttle wait end at once, including a `Retry-After` wait of up to an hour, and the command exits `2`.
- Restore writes already sent to Microsoft 365 finish, so what the restore reports matches what was written. An interrupted restore prints what it restored before the stop, and the message or file in flight is not counted as failed.
- The folder, drive, or library in progress keeps its previous sync checkpoint (a Microsoft Graph delta link), so the next run reads it again. Microsoft 365 has no cancel, so a request it already accepted still completes on its side and Atlas drops the result.

A second Ctrl+C exits at once with status `130`, with no cleanup and no final report. Writes that completed before it stay in the mailbox or drive, the write in flight may or may not have landed, and an unfinished `save` archive may be unusable. See [Retries and fail-safes](/operations/reliability) for `SIGTERM` and systemd.

### Run leases

Atlas runs one operation at a time per mailbox, drive owner, site, or team. It does this with a lease, stored in the tenant bucket (see [Owner leases](/operations/storage-layout#owner-leases)), that each command takes before it writes:

| Lease        | Taken by                                                                     | Covers                                       |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Owner lease  | Every backup, restore, deletion, and quarantine                              | One mailbox, drive owner, site, or team      |
| Tenant lease | `atlas delete --purge`, `atlas keys rewrap`, `atlas keys purge-old-wrappers` | The whole tenant, one tenant at a time       |

- The two kinds exclude each other. A tenant command is refused while any owner lease in that tenant is live, and an owner command exits `12` while a tenant command holds the tenant.
- A purge that exits `12` names the busy owner in its message and wrote nothing.
- The `keys` commands cover several tenants, so they do not exit `12`. A busy tenant is reported as `busy, skipped`, the other tenants are still processed, and the run exits `2`. Treat that `2` as incomplete, not as nothing written: other tenants may already be re-wrapped or purged. Rerun the same command after the busy operation ends; it skips what is already done. Run these commands when no scheduled backup of the tenant is due.
- A restore takes the owner lease of the mailbox, drive owner, or site it reads, in the bucket it reads from, also when `--target-profile` sends the writes to another tenant. A restore whose storage credentials cannot write the lease (HTTP `403`) still runs, without a lease, and logs `concurrent-run protection is off for this restore`. A backup, deletion, or second restore of that owner is then not refused. A live lease held by another operation still refuses the restore, because reading a lease needs no write access.
- The lease is not encrypted, so a deletion needs no passphrase for it.

Lease lifetime and renewal are listed in [Retries and fail-safes](/operations/reliability).

### Fatal error diagnostics

```text
[x] Consent required
[x]   Atlas code: ATLAS_AUTH_DENIED
[x]   Cause: Permission denied
[x]   HTTP status: 403
[x]   Transport code: ErrorAccessDenied
```

The CLI prints the Atlas code separately from the Graph code, HTTP status, response body, or AWS error name. Fatal diagnostics, including `DEBUG` stacks, go to stderr so redirected stdout stays clean.

::: warning Redact before sharing
Diagnostics can contain tenant identifiers and sensitive content. Redact them before sharing logs.
:::

## Global options

```bash
atlas --profile contoso outlook backup -m john.doe@example.com
atlas outlook backup -m john.doe@example.com --profile fabrikam
```

| Option             | Environment     | Description                                                                                                                                  |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>` | `ATLAS_PROFILE` | Tenant profile whose Graph credentials the run uses. Defaults to the active profile. See [Selecting a profile](/configuration#selecting-a-profile). |
| `-V, --version`    |                 | Print the installed version                                                                                                                  |
| `-h, --help`       |                 | Print help for the program or any command                                                                                                    |

Place `--profile` before or after the subcommand. Shared settings (S3 and the encryption passphrase) are the same for every profile, so `--profile` changes only the Microsoft Graph identity. Restore commands also accept `--target-profile <name>` to write into a second tenant; see [Cross-tenant restore](/reference/cli-recovery#cross-tenant-restore).

## Short flags

A short flag means one thing across the CLI.

| Flag | Meaning                                       | Notes                                                                            |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `-s` | `--snapshot`                                  | Every command that acts on a snapshot. `stats` does not accept it.               |
| `-o` | `--owner`                                     | A drive owner. `--output` has no short flag on any command.                      |
| `-f` | `--folder` on Outlook, `--file` on the drives | One value each. Repeat `-f` to name several Outlook folders.                     |
| `-t` | `--tenant`                                    | Every command.                                                                   |
| `-m` | `--mailbox`                                   | Every command that acts on a mailbox. Takes an email address or Entra object ID. |

`--site` and `--team` have no short flag, so nothing can shadow `-s` or `-t`. A retired spelling is rejected rather than reinterpreted, and the error names its replacement:

| Retired spelling                 | Pass instead |
| -------------------------------- | ------------ |
| `-s <site>` on `atlas stats`     | `--site`     |
| `-O <path>` on any `save`        | `--output`   |
| `-o <path>` on `atlas outlook save` | `--output` |

```console
$ atlas stats -s https://contoso.sharepoint.com/sites/Engineering
error: option '-s <value>' argument 'https://...' is invalid. -s no longer means --site in v5.0.0. Pass --site instead.
```

## Identifiers

| Target                | Accepted forms                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox, drive owner  | Email address or Entra object ID                                                                                                                                            |
| Site (`--site`)       | Browser URL (`https://contoso.sharepoint.com/sites/Engineering`), Graph short form (`contoso.sharepoint.com:/sites/Engineering`), or site ID with or without its hostname (`contoso.sharepoint.com,<siteGuid>,<webGuid>` or `<siteGuid>,<webGuid>`) |

- An email address is looked up through Microsoft Graph before any object path is built. Object IDs are used as given. Backups are keyed by object ID, so the address is display metadata only.
- Owner and site IDs are case-insensitive. They are lowercased before they become object paths, so one identifier always addresses one tree.
- Object paths use `<siteGuid>,<webGuid>`, so a SharePoint domain rename does not start a second backup history. See [SharePoint storage layout](../sharepoint-backup.md#storage-layout).
- Commands that read existing backups (`list-snapshots`, `list-versions`, `save`, `verify`, `status`, `delete`, the source site of `restore`, and `atlas stats --site`) drop the hostname from a site ID with string handling alone. They make no Graph call, so backups of a site deleted from SharePoint stay reachable and disaster recovery works while Graph is unavailable.
- `backup` and `restore --target-site` always look the site up through Graph, because they work on the live site.

## atlas outlook

Back up, restore, export, verify, and manage Outlook mailboxes. Storage and tenant-wide commands live at the root.

Mailboxes are identified by Entra object ID. `-m` accepts an email address or an object ID, and a value containing `@` is looked up through `GET /users/{email}` first. Backups written by v5 were keyed by address; see [Migrating to v6](/migration/v6).

`restore`, `list`, and `save` select what to act on with `-s, --snapshot` (one snapshot) or `-m, --mailbox` (every snapshot for a mailbox):

- `list` and `save` given both use `-s`, warn that `-m` was ignored, and continue. A snapshot ID is the narrower request, and Atlas never widens it silently.
- `restore` given both refuses the pair and exits `1`, because guessing would decide which mailbox receives the mail. Choose the destination with `-T, --target`, which works in both modes and selects where mail lands, never what gets restored:

```bash
atlas outlook restore -s <snapshot-id> -T other@example.com
```

### atlas outlook backup

Back up one mailbox to object storage, with a per-folder progress dashboard.

```bash
atlas outlook backup -m user@example.com                               # incremental backup
atlas outlook backup -m user@example.com --full                        # ignore saved sync checkpoints
atlas outlook backup -m user@example.com -f Inbox -f "Sent Items"      # specific folders only
atlas outlook backup -m user@example.com -P 50                         # larger page size
atlas outlook backup -m user@example.com --retention-days 30 --lock-mode governance
atlas outlook backup -m user@example.com --retention-days 365 --lock-mode compliance
atlas outlook backup -t <tenant-id> -m user@example.com                # explicit tenant
```

| Option                        | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `-m, --mailbox <id>`          | Mailbox email address or Entra object ID to back up (required)               |
| `-f, --folder <name>`         | Limit to one folder by name or path. Repeat for several.                     |
| `--full`                      | Ignore saved delta links and run a full backup                               |
| `-P, --page-size <n>`         | Graph API page size per delta request (1 to 100, default 10)                 |
| `--retention-days <n>`        | Apply Object Lock retention for `n` days                                     |
| `--lock-mode <mode>`          | Object Lock mode, `governance` or `compliance`. Requires `--retention-days`. |
| `-t, --tenant <id>`           | Override the tenant ID from config                                           |
| `--exclude-junk`              | Skip the Junk Email folder and its subfolders                                |
| `--include-recoverable-items` | Also back up hard-deleted and hold-retained mail (see below)                 |

The run ends with this line:

```text
Snapshot <id> -- <n> objects (<size> captured by this run)
```

`<n>` counts the messages in the snapshot's chain, the same set `verify`, `restore -s`, and `save -s` read, so it rises when mail arrives and falls when the run records deletions. `<size>` is only what this run captured. A run that captured nothing reports the existing newest snapshot and its count.

- **One mailbox per run.** To back up several, list them with `atlas outlook mailboxes` and loop from your scheduler. Atlas does not fan out across mailboxes itself.
- **Object Lock.** `--lock-mode` alone is rejected, so a run meant to be immutable cannot exit `0` with unprotected data. Retention without a mode defaults to `governance`. Atlas turns `--retention-days` into a UTC `retain_until`, checks that the bucket supports versioning and Object Lock in the requested mode, and stops before writing if it does not, instead of writing unprotected data. See [Immutability and Object Lock](/operations/immutability).

#### Which folders are backed up

Every mail folder in the mailbox is backed up at any depth, including folders Outlook treats as special:

| Folder                                                      | Backed up | Note                                                                                                                                   |
| ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox, Sent Items, Deleted Items, Archive, and user folders | Yes       | Including nested subfolders                                                                                                            |
| **Drafts** and **Outbox**                                   | Yes       | Unsent work exists nowhere else                                                                                                        |
| **Junk Email**                                              | Yes       | Opt out with `--exclude-junk`. Junk is evidence in a phishing or business email case.                                                  |
| Hidden folders (`isHidden`)                                 | Yes       | Listed explicitly, since Graph omits them by default                                                                                   |
| Hidden Exchange system folders                              | No        | A short deny list of client-state folders, such as `Conversation Action Settings`, matched only when Exchange also reports them hidden |
| In-Place Archive mailbox                                    | No        | Graph cannot read it. See [In-Place Archive is out of scope](../security.md#in-place-archive-is-out-of-scope).                         |
| **Recoverable Items**                                       | Opt-in    | `--include-recoverable-items`. See below.                                                                                              |

Anything skipped is reported at the end of the run and recorded in the snapshot manifest with its reason:

```text
[!] 1 folder(s) not backed up:
      Junk Email (skipped by --exclude-junk)
```

- A folder deleted while the backup lists folders is skipped, with everything beneath it, and reported as `deleted while the folder list was read, not captured`. The run continues and records no removals. Folders that reported removals keep their previous delta links, so the next run picks them up. A `--folder` run records no removals anyway and advances its links as usual. See [Delta sync](/operations/delta-sync#deleted-and-moved-messages-outlook).
- A `404` on the mailbox's top-level folder listing still fails the run, because it means the mailbox is gone.

#### Recoverable Items

```bash
atlas outlook backup -m user@example.com --include-recoverable-items
```

Mail that arrives and is hard-deleted between two backups never appears in an incremental backup. Its only copy in the tenant is the Recoverable Items subtree, and once Exchange's retention window expires it is gone from the tenant and from every snapshot. This flag reads that subtree.

| Subfolder          | Backed up | Contains                                                                    |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `Deletions`        | Yes       | Items removed from Deleted Items, recoverable by the user for 14 to 30 days |
| `Purges`           | Yes       | Hard-deleted items retained only by litigation hold or single item recovery |
| `DiscoveryHolds`   | Yes       | Hard-deleted items retained by an In-Place Hold or retention policy         |
| `SubstrateHolds`   | Yes       | Original copies of held Teams messages and modified held items              |
| `Versions`         | No        | Pre-modification copies whose item shape is not a message                   |
| `Calendar Logging` | No        | Calendar change audit trail                                                 |
| `Audits`           | No        | Mailbox audit log entries                                                   |

- The flag is off by default. On a mailbox under litigation hold the dumpster can be as large as the mailbox, so that cost should be a deliberate choice. With the flag off, the subtree is not even located and request volume is unchanged.
- Subfolders Atlas does not recognize are reported rather than guessed at, so a new Exchange subfolder shows up as a visible gap.

::: warning Restoring purged mail is opt-in twice
Entries captured this way are marked in the manifest, and `restore` and `save` exclude them by default, so an ordinary restore does not resurrect deleted mail or mail that exists only because a hold kept it. Pass `--include-recoverable-items` to the restore or save command as well, including when naming one message with `--message`. Without it, Atlas logs how many of the selected messages it skipped; a selection that holds no Recoverable Items entry logs nothing.

Graph cannot write into Recoverable Items. Recovered items land in the normal restore folder under `Recoverable Items/<subfolder>` (for example `Restore-<timestamp>/Recoverable Items/Deletions`), and `save` uses the same path inside the archive. Select one subfolder with `--folder "Recoverable Items/Deletions"`. See [Recoverable Items and legal hold](../security.md#recoverable-items-and-legal-hold) for the compliance implications.
:::

#### Page size and folder selection {#page-size-nested-folders-and-immutability}

- **Page size.** `--page-size` sets the `Prefer: odata.maxpagesize` hint for each delta request, and the server can return fewer items when messages are large. Smaller pages save progress more often during an interrupt. Larger pages use fewer round trips. The default of 10 suits most mailboxes.
- **Request cost.** Each new or changed message costs one `/$value` request for its MIME, plus one `$batch` round trip per page for reactions and the pin: N/10 round trips for N messages at the default page size, N/20 at `--page-size 100`. Each message in a batch still counts once against the mailbox's 10,000-request window. See [Reactions, flag, and pin](/operations/delta-sync#reactions-flag-and-pin).
- **Nested folders.** Atlas walks the whole folder hierarchy, not only the top-level folders that `GET /users/{id}/mailFolders` returns. Folders are identified by root-relative path, such as `Inbox/Projects/2026`, and `status`, backup progress, and `save` show that path. Recursion stops at 300 levels, matching Exchange's own limit, and deeper folders are skipped with a warning. Excluded system folders are pruned with their subtrees.
- **Matching `--folder`.** A value matches a full path (`Inbox/Projects`) or a folder name at any depth (`Projects`), case-insensitively, and always includes everything beneath it: `--folder Inbox` covers `Inbox`, `Inbox/Projects`, and `Inbox/Projects/2026`. Use the full path when one name exists under several parents. `restore` and `save` match `--folder` the same way.
- **Well-known names.** A value can also be `inbox`, `drafts`, `sentitems`, `deleteditems`, `junkemail`, `archive`, `outbox`, or `conversationhistory`. Display names follow the mailbox language, so `--folder sentitems` selects Sent Items in a mailbox of any language, while `--folder "Sent Items"` matches only an English display name.
- **No match is an error.** When no `--folder` value matches, `backup`, `restore`, and `save` stop with `ATLAS_NOT_FOUND` (exit `7`) and list the folders that exist, so a mistyped or localized name in a scheduled job does not store an empty snapshot and exit `0`. `backup` checks selectors while holding the mailbox lease and before writing a snapshot. `restore` and `save` check after they read the snapshot, before they create a restore folder or an archive. When some values match, `backup` backs up those folders, reports each unmatched value as a folder error, and exits `2`.

### atlas outlook verify

Check that every object a snapshot needs can be read back and matches its checksum.

```bash
atlas outlook verify -m user@example.com -s <snapshot-id>
atlas outlook verify -m user@example.com -s <snapshot-id> -t <tenant-id>
atlas outlook verify -m user@example.com -s <snapshot-id> --fast
```

| Option                        | Description                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Mailbox that owns the snapshot (required). Verification stops if the snapshot belongs to another mailbox. |
| `-s, --snapshot <id>`         | Snapshot identifier to verify (required)                                                                  |
| `-t, --tenant <id>`           | Override the tenant ID from config                                                                        |
| `--fast`                      | Existence checks only (a `HeadObject` per referenced object). No download, decryption, or hashing.        |

- **What is checked.** Verification reads the snapshot's merged manifest chain, the same view `restore` uses: the target manifest and every older manifest for the mailbox, deduplicated newest first. Every referenced object, including message bodies and attachments, is downloaded, decrypted, re-hashed with SHA-256, and compared with the manifest checksum. AES-256-GCM authentication rejects tampered ciphertext during decryption.
- **Older damage propagates.** A corrupt or missing object from an older run fails verification of every later snapshot that still references it.
- **Ownership first.** Before any object is read, Atlas checks that the snapshot belongs to `-m`. An object ID is compared directly. An address is compared as typed, which matches snapshots v5 wrote under the address, and is otherwise looked up through Graph. A snapshot owned by another mailbox, or a missing snapshot, exits `7` and verifies nothing.
- **Unverifiable entries.** Entries with no stored object, such as large attachments skipped by backups before v2.1.0, are reported as **unverifiable** and fail the run, because a restore cannot reproduce them.
- **`--fast`** confirms that every referenced object exists. It catches the most common damage, such as lifecycle deletion, an incomplete copy to a replica, or manual cleanup, at near-zero bandwidth. Schedule full verification as well, since only it checks ciphertext integrity through the GCM tag.
- **What counts as a failed object.** Only damage: an object the bucket reports as absent (`NoSuchKey` or `NotFound`), ciphertext that fails its GCM tag, or a checksum mismatch. Any other storage error stops the run with its own category: a `403` exits `4`, and a `503` or network error exits `3`. An expired credential or an outage says nothing about the backup, so it is never reported as a list of failed objects.
- A failed verification exits `1`.

### atlas outlook restore

Restore mail from a backup into a Microsoft 365 mailbox.

**Snapshot mode** restores one snapshot:

```bash
atlas outlook restore -s <snapshot-id>
atlas outlook restore -s <snapshot-id> -f Inbox
atlas outlook restore -s <snapshot-id> --message 42
atlas outlook restore -s <snapshot-id> -T target@example.com
atlas outlook restore -s <snapshot-id> --destination "Recovered/2026-03 incident"
```

**Mailbox mode** combines every snapshot for a mailbox, deduplicates them, and restores the result. The newest version of each message wins:

```bash
atlas outlook restore -m user@example.com
atlas outlook restore -m user@example.com -f Inbox
atlas outlook restore -m user@example.com --start-date 2026-01-01
atlas outlook restore -m user@example.com --start-date 2026-01-01 --end-date 2026-06-30
atlas outlook restore -m user@example.com -T other@example.com
atlas outlook restore -m user@example.com -T other@example.com -f Inbox
```

| Option                        | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `-s, --snapshot <id>`         | Restore from a specific snapshot                                             |
| `-m, --mailbox <email-or-id>` | Restore from all snapshots for this mailbox                                  |
| `-T, --target <email>`        | Target mailbox for a cross-mailbox restore (defaults to the source)          |
| `-f, --folder <name>`         | Restore only messages from this folder or its subfolders                     |
| `--message <ref>`             | Restore one message by `#` from `atlas outlook list -s`. Requires `-s`       |
| `--destination <path>`        | Folder to restore under, created if missing (default: `Restore-<timestamp>`) |
| `--start-date <YYYY-MM-DD>`   | Include snapshots created on or after this date                              |
| `--end-date <YYYY-MM-DD>`     | Include snapshots created on or before this date                             |
| `-t, --tenant <id>`           | Override the tenant ID from config                                           |
| `--target-profile <name>`     | Tenant profile for the writes. Requires `-T`                                 |
| `--include-recoverable-items` | Also include hard-deleted and hold-retained mail (excluded by default)       |

The restore takes the mailbox's [owner lease](#run-leases), so it exits `12` while a backup, deletion, quarantine, or another restore of that mailbox runs.

#### Selecting what to restore

- Exactly one of `--snapshot` or `--mailbox` is required. Passing both exits `1` (see [atlas outlook](#atlas-outlook)). `-T` works in either mode.
- `--message` works in snapshot mode only. With `--mailbox` it exits `1` before any storage read or Graph call, because a `#` index counts one snapshot's messages and mailbox mode merges many. An empty or whitespace-only `--message` exits `1` in either mode rather than selecting every message.
- A `--message` reference that names no message exits `7` (`ATLAS_NOT_FOUND`) and names the reference. Atlas checks it after reading the snapshot chain and before it takes the lease, creates a folder, or writes a message, so a mistyped index leaves no empty folder behind.
- Snapshot mode reads the snapshot's whole chain: the target plus every older snapshot of the same mailbox, with the newest version of each message winning. Later snapshots and other mailboxes are excluded. This is the set `atlas outlook verify -s` checks, so a snapshot that verifies restores the same messages. A `--message` index counts the target snapshot's own messages, as `atlas outlook list -s` prints them. A full message ID matches anywhere in the chain.
- `-f` matches on the `folder_id` recorded in the manifest. Older snapshots without that field recover it from their Graph JSON entries. A MIME entry in such a snapshot has no folder to recover, because RFC 822 does not record one, so `-f` skips it and reports the count on stderr. Restore or save without `-f` to include those entries.
- A message deleted from the mailbox before a snapshot is not restored from it. Removals are recorded only by a run that finished every folder without `--folder` or `--exclude-junk`, so a message deleted around a filtered, excluded, or interrupted run, or in a snapshot that predates removal tracking, still comes back. See [Deleted and moved messages](/operations/delta-sync#deleted-and-moved-messages-outlook).

#### Where restored mail lands

- By default each restore writes into a new `Restore-{timestamp}` folder at the top of the mailbox and recreates nested folders beneath it: `Inbox/Projects/2026` restores to `Restore-.../Inbox/Projects/2026`. Cross-mailbox restores keep the source folder names.
- `--destination` replaces the generated root with a folder path relative to the top of the mailbox, with `/` between levels. `Inbox/Projects/2026` then restores to `<destination>/Inbox/Projects/2026`, and the summary names the destination.
- Folder names are matched case-insensitively, as Exchange compares them. Each level of the destination, and each source folder beneath it, is reused when it exists and created when it does not. Hidden folders are never reused.
- A destination inside a well-known folder such as Inbox, Sent Items, or Deleted Items is refused with exit `1` before anything is created, so restored mail never mixes into live mail with no single folder to delete. Well-known folders are recognised by ID, so localized names are covered.
- An empty path, `/`, or a path with an empty level such as `Recovered//2026` is refused with exit `1` before any Graph call. Outlook has no in-place restore, so `/` cannot mean the original folders.
- A folder whose name contains `/` cannot be addressed. Restore it under the default root.

::: warning A restore does not deduplicate
Restore does not compare against what the target folder already holds. Restoring the same snapshot twice into one destination creates every message twice. The default root avoids this, because each run gets a new folder.
:::

#### Folder names and the source mailbox

Folder names come from the folders each snapshot recorded, newest snapshot first. A folder deleted, moved, or renamed since the backup restores under its original path, and `-f` selects it by that path or by its well-known name such as `inbox`.

Snapshots taken with Atlas 5.2.3 or later record every folder they capture, so restoring or saving them never lists the source mailbox. They work for a user who has left the organisation, lost the Exchange licence, or lives in another tenant (`--target-profile`). Graph is called only for the target mailbox.

The source mailbox is listed only when the manifests fall short:

- **A message's folder is recorded in no snapshot**, as in snapshots written before Atlas 5.2.3. If Graph then answers that the source mailbox does not exist or is unlicensed, the run exits `7` (`ATLAS_NOT_FOUND`) before it writes a message, and the error says how many folders the manifests do not name. A whole-snapshot or mailbox restore stops before it creates any folder; a `--message` restore has already created its restore root. Any other listing failure, such as throttling, ends the run as it is. A folder still unnamed after the listing restores into `Unknown`.
- **`-f` matches no recorded folder.** The live listing is then checked too, for a folder role the backup could not tag. When that listing fails, `-f` exits `7` and lists the recorded folders.

A folder deleted while the restore lists the source mailbox's folders is skipped with a warning, and the restore continues.

#### What a restored message looks like

- Restored messages keep their original received and sent timestamps, appear as received mail rather than drafts, and include all backed-up attachments. Attachments larger than 3 MB use Graph upload sessions.
- Messages archived as RFC 5322 MIME are parsed at restore time and recreated through Graph's JSON message-create path, because Graph's MIME import always marks the created message as a draft. The restored copy does not carry the original `Received:` chain. For the original bytes, use [`atlas outlook save`](#atlas-outlook-save).
- A meeting response restores as a meeting response with its meeting time and location, where the message states them unambiguously. A meeting request or cancellation restores as an ordinary message, because Microsoft Graph refuses to create those. See [Meeting messages](/security#meeting-messages).
- A message that receives fewer attachments than its snapshot holds is listed as a warning, for example `<message-id>: 1 of 2 attachments restored`. A failed upload is an error and exits `2`. A legacy attachment that was never backed up is skipped with a warning only.

#### Stopping an Outlook restore

Ctrl+C stops the restore at once, including a message create or attachment upload parked in a Graph retry or throttle wait. The run prints how many messages it restored and exits `2`. The folder they went into is named when the restore starts.

- A create or upload already sent to Graph finishes, so a created message is counted. A message stopped before its create was sent is not reported as failed.
- A message created before the stop whose attachments were not all uploaded is reported once as `<message-id>: N attachment(s) not uploaded: the run was interrupted`. Delete it, or restore again into a fresh folder.
- A second Ctrl+C exits at once with status `130`.

### atlas outlook list

Browse backed-up mail at three levels: mailboxes, snapshots, and messages.

```bash
atlas outlook list                              # all mailboxes with summary stats
atlas outlook list -m user@example.com          # all snapshots for a mailbox
atlas outlook list -s <snapshot-id>             # messages inside a snapshot (first 50)
atlas outlook list -s <snapshot-id> --all       # all messages
atlas outlook list -s <snapshot-id> -S          # reveal email subjects
```

| Option                        | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Show snapshots for this mailbox                         |
| `-s, --snapshot <id>`         | Show messages inside this snapshot                      |
| `--all`                       | Show all messages (the default caps at 50)              |
| `-S, --subjects`              | Reveal subjects (hidden by default for data protection) |
| `-t, --tenant <id>`           | Override the tenant ID from config                      |

- **`Type` column.** The mailbox overview shows the purpose (`user`, `shared`, `room`, and so on) from the newest manifest that recorded one, or `--` when none was recorded.
- **`Objects` column.** Counts the messages in a snapshot's chain, the set `verify`, `restore -s`, and `save -s` read, so it drops when a backup records deletions. The overview shows it for the latest snapshot; `list -m` shows it for each snapshot, counting that snapshot and every older one. `restore` and `save` leave Recoverable Items messages out unless you pass `--include-recoverable-items`, and report how many they skipped.
- **Speed.** `list -m` and the overview read each mailbox's [snapshot summary index](/operations/storage-layout#snapshot-summary-index) instead of decrypting every manifest. No manifest is decrypted unless a snapshot has no row yet.
- **`list -s`** shows only the messages recorded by that backup run, not the whole chain that `restore -s` and `save -s` read. Its `#` index is what `--message` resolves against.

### atlas outlook read

Decrypt and display one backed-up message.

```bash
atlas outlook read -s <snapshot-id> --message 34
atlas outlook read -s <snapshot-id> --message 34 --raw
atlas outlook read -s <snapshot-id> --message 34 --raw > message.eml
```

| Option                | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| `-s, --snapshot <id>` | Snapshot that contains the message (required)                              |
| `--message <ref>`     | Message `#` from `atlas outlook list`, or full Graph message ID (required) |
| `--raw`               | Output the stored object verbatim instead of the formatted view            |
| `-t, --tenant <id>`   | Override the tenant ID from config                                         |

- **Lookup.** Like `restore -s`, `read` looks in the snapshot's whole chain. A `#` index counts the snapshot's own messages and decrypts only that manifest. A full message ID also finds a message stored by an older snapshot of the same mailbox. A message the chain records as deleted is not found, and a reference that names no message exits `7` (`ATLAS_NOT_FOUND`).
- **`--raw` on MIME.** Current snapshots store RFC 5322 MIME, which `--raw` writes to stdout as the decrypted bytes, with no banner, colour, or added newline. Redirected output is a valid `.eml` file with its original `Received:` chain, `Authentication-Results`, and any S/MIME payload intact. Use it to hand a message to an investigator or to check a DKIM signature.
- **`--raw` on legacy JSON.** An entry stored as Graph JSON prints as JSON with two-space indentation. The manifest entry's `payload_format` field tells the formats apart: `"mime"` means original bytes, and a missing field means legacy JSON.
- **Formatted view.** The same for both formats: subject, from, to, cc, date, a separator, and the decoded `text/plain` body, falling back to the HTML part converted to text. Attachment name, MIME type, and size are listed below the body, including attachments embedded in archived MIME.

### atlas outlook save

Export backed-up mail as standard `.eml` files (RFC 5322) in a zip archive, without touching the mailbox.

**Snapshot mode:**

```bash
atlas outlook save -s <snapshot-id>
atlas outlook save -s <snapshot-id> -f Inbox
atlas outlook save -s <snapshot-id> --message 42
atlas outlook save -s <snapshot-id> --output ~/Downloads/backup.zip
atlas outlook save -s <snapshot-id> --skip-verify
```

**Mailbox mode:**

```bash
atlas outlook save -m user@example.com
atlas outlook save -m user@example.com -f Inbox
atlas outlook save -m user@example.com --start-date 2026-01-01
atlas outlook save -m user@example.com --start-date 2026-01-01 --end-date 2026-06-30
```

| Option                        | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `-s, --snapshot <id>`         | Save from a specific snapshot                                          |
| `-m, --mailbox <email-or-id>` | Save from all snapshots for this mailbox                               |
| `-f, --folder <name>`         | Save only messages from this folder or its subfolders                  |
| `--message <ref>`             | Save one message by `#` from `atlas outlook list -s`. Requires `-s`    |
| `--start-date <YYYY-MM-DD>`   | Include snapshots created on or after this date                        |
| `--end-date <YYYY-MM-DD>`     | Include snapshots created on or before this date                       |
| `--output <path>`             | Output file path (default: `Restore-<timestamp>.zip`)                  |
| `--skip-verify`               | Skip SHA-256 integrity checks (faster on low-power systems)            |
| `-y, --yes`                   | Overwrite an existing output file without asking                       |
| `-t, --tenant <id>`           | Override the tenant ID from config                                     |
| `--include-recoverable-items` | Also include hard-deleted and hold-retained mail (excluded by default) |

The archive mirrors the Outlook folder hierarchy:

```text
Restore-2026-03-10T14-30-00.zip
  Inbox/
    2026-03-10_143022_Meeting-with-client.eml
    2026-03-10_090115_Weekly-report.eml
  Sent Items/
    2026-03-09_161200_Re-Project-update.eml
  Archive/
    2026-01-15_080000_Old-thread.eml
```

- **Fidelity.** MIME messages are written **byte for byte** from the stored object, so the exported file is the message Exchange received. Legacy JSON entries are rebuilt into `.eml` at export time. Attachments are embedded as MIME parts in both cases. A mailbox backed up before v4 and kept incremental holds both formats, and `save` writes an `.eml` for each.
- **Verification.** Every message and attachment is SHA-256 verified after decryption unless `--skip-verify` is set. A legacy attachment that cannot be fetched or decrypted, or that has a size but no stored content, is left out of its `.eml` and listed as an integrity failure naming the message and attachment (`message:<message-id> attachment:<attachment-id>`). The run exits `2`.
- **Scope flags.** With both `-s` and `-m`, the named snapshot is exported and `-m` is ignored with a warning. `--message` needs `-s`; with `-m` alone it exits `1` before any storage read or Graph call. An empty or whitespace-only `--message` exits `1`. A reference that names no message exits `7` before the archive is opened, so no zip file is written, and a stream destination is destroyed rather than left open.
- **Folder and file names.** Archive folders are named the way [`restore`](#atlas-outlook-restore) names folders: from what the snapshots recorded first, then from the live mailbox. A snapshot taken with Atlas 5.2.3 or later saves without the source mailbox, so a departed user's backup can still be exported. File names use `YYYY-MM-DD_HHmmss_Sanitized-subject.eml`, with the time taken from `receivedDateTime`, so they sort chronologically. Duplicate names within a folder get numeric suffixes (`_1`, `_2`).
- **Existing output.** If the output file exists, Atlas asks `Overwrite? [Y/n]`. `-y` overwrites without asking. With stdin at EOF the prompt gets no answer, so `save` exits `1` and leaves the file untouched. A scheduled export to a fixed path needs `-y`.
- **Ctrl+C** stops the export and exits `2`. The archive holds the messages written before the stop. A stop during the Graph folder listing, before any message is written, leaves no archive. A second Ctrl+C exits at once with status `130`.

::: warning Exported files on Windows are marked as internet-sourced
On Windows, Atlas stamps the archive with Mark-of-the-Web: a `Zone.Identifier` stream carrying `ZoneId=3`. Atlas does not vet tenant content, so the export keeps the protection the file would have had from a browser or mail attachment, and Office opens recovered documents in Protected View with macros blocked. Windows Explorer and WinRAR copy the mark to every extracted file. Once you have decided the content is trustworthy, clear it:

```powershell
Get-ChildItem -Recurse .\Restore-2026-03-10 | Unblock-File
```

macOS and Linux write nothing, since they have no equivalent. If the target filesystem cannot store alternate data streams, such as FAT32 or exFAT media or an SMB share on a non-NTFS server, the export still succeeds and logs a warning.
:::

### atlas outlook delete

Delete one mailbox's backed-up mail, or its newest snapshot, behind a confirmation prompt.

```bash
atlas outlook delete -m user@example.com        # all data and manifests for a mailbox
atlas outlook delete -s <snapshot-id>           # newest snapshot manifest (data retained)
atlas outlook delete -m user@example.com -y     # skip the confirmation prompt
```

| Option                        | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Delete all data, attachments, and manifests for a mailbox             |
| `-s, --snapshot <id>`         | Delete the mailbox's newest snapshot manifest (data objects retained) |
| `-y, --yes`                   | Skip the confirmation prompt                                          |
| `-t, --tenant <id>`           | Override the tenant ID from config                                    |

This covers mail only. For a tenant-wide purge, use [`atlas delete`](#atlas-delete). `atlas outlook delete --purge` no longer exists.

- **Order.** Atlas deletes manifests first, then data objects. An interrupted delete leaves orphan objects, which are harmless, rather than manifests that point at missing data. `--snapshot` removes only the manifest, because other snapshots may reference the same objects.
- **Lease.** Every workload's `delete` and `quarantine` takes the [owner lease](#run-leases), so it exits `12` while a backup of the same owner runs, and a backup exits `12` while the deletion runs.
- **`--mailbox`** also removes the mailbox's delta cursor (`_meta/outlook-cursors/`) and the Atlas 6 replication status records of the deleted snapshots. Records under `_meta/replication/` that belong to a OneDrive snapshot of the same user stay; [Legacy Atlas 6 objects](/operations/replication#legacy-atlas-6-objects) shows how to remove them. The next backup is a full backup.
- **`--snapshot` accepts only the newest snapshot.** Each snapshot stores only its own run's changes and every newer one is built on the chain before it, so deleting an older one would drop the messages it recorded from every later snapshot and bring back the ones it recorded as deleted. Atlas refuses that with `SnapshotNotNewestError` (`ATLAS_SNAPSHOT_NOT_NEWEST`, exit `11`) and deletes nothing. Delete the newer snapshots first, newest first, or the whole mailbox with `--mailbox`.
- **A damaged manifest blocks `--snapshot`.** If a manifest of the mailbox cannot be read, the order cannot be checked: the delete exits `9` and names it. Move it aside with [`atlas outlook quarantine`](#atlas-outlook-quarantine) and retry.
- **After `--snapshot`.** The delta cursor, which points past the deleted run, and the snapshot's row in the [summary index](/operations/storage-layout#snapshot-summary-index) are removed too. The next backup resumes from the sync checkpoints in the remaining newest snapshot and captures again every change the deleted snapshot held. A cursor left behind anyway, for example by an interrupted delete, is resumed only while the snapshot it was saved with is still the newest readable one; otherwise every folder is read in full.
- **Erasure.** Every delete removes the object together with all of its noncurrent versions, so a deletion that reports success has erased the data. A plain delete in a versioned bucket would only write a delete marker.
- **Object Lock.** Objects under retention are reported as retained, separately from failures, and the command exits `1`. "Retained" means the backend cited Object Lock as the reason; those objects become deletable when retention expires. Other failures, such as an IAM denial or an unreachable endpoint, are reported as failures because they will not clear on their own. See [Erasure](/security#erasure).

### atlas outlook status

Check whether a mailbox backup is current, without running a backup.

```bash
atlas outlook status -m user@example.com
atlas outlook status -m user@example.com -t <tenant-id>
```

| Option                        | Description                        |
| ----------------------------- | ---------------------------------- |
| `-m, --mailbox <email-or-id>` | Mailbox to check (required)        |
| `-t, --tenant <id>`           | Override the tenant ID from config |

```text
╭────────────────╮
│  Atlas Status  │
╰────────────────╯
Tenant:  <tenant-id>
Mailbox: user@example.com
[*] Last backup: 2026-03-18 14:30 (snap-abc123)

Folder      Status           Pending
----------  ---------------  -------
Inbox       up-to-date             0
Sent Items  3 change(s)            3
Projects    250+ change(s)      250+
Archive     never backed up        -

[*] Overall: 253+ pending change(s), 1 folder(s) never backed up across 4 folder(s)
```

- The command replays the saved delta links from the latest manifest against Graph to count pending changes.
- The pending count is exact up to 5 delta pages of 50 messages per folder. Delta pages carry message bodies, so counting further would download what the next backup downloads anyway. A folder with more changes shows the count it reached followed by `+`, and the SDK sets `pendingCapped`.
- A Graph permission or authentication failure (`401`, `403`, or an unlicensed mailbox) stops the command with exit `4` and `ATLAS_AUTH_DENIED` or `ATLAS_MAILBOX_NOT_LICENSED`, as for `backup`. Any other failure, such as a throttle that outlasted the retries, marks that folder `peek failed` with the error class and message, and the mailbox is reported as not up to date.

### atlas outlook mailboxes

List the tenant's mailboxes live from Microsoft Graph, not from the backup catalog.

```bash
atlas outlook mailboxes
atlas outlook mailboxes --licensed-only
atlas outlook mailboxes -t <tenant-id>
```

| Option              | Description                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- |
| `--licensed-only`   | Show only mailboxes with an active Exchange Online license (excludes shared mailboxes) |
| `-t, --tenant <id>` | Override the tenant ID from config                                                     |

- The output shows each mailbox's Entra object ID (the value to pass to `-m`), email address, display name, Exchange Online license status, account status, mailbox type, and creation date.
- Mailbox size requires the `Reports.Read.All` Graph permission. Without it, the Size column is omitted without an error.
- The `Type` column shows `mailboxSettings.userPurpose` (`user`, `shared`, `room`, `equipment`, and so on). To keep discovery fast, Atlas resolves it only for unlicensed mailboxes, and `--` means it was not resolved. `--licensed-only` excludes shared mailboxes, which are usually unlicensed.

::: warning An In-Place Archive is not backed up
The `Archive` column comes from the same `Reports.Read.All` report and shows whether a mailbox has an **In-Place Archive** (Online Archive). Graph cannot read archive mailboxes, so that content is outside backup scope, and the command prints a warning naming each affected mailbox. `--` means **unknown**, not "no archive": the permission is missing or the report left out the column. This is not the `Archive` folder used by Outlook's Archive button, which lives in the primary mailbox and is backed up normally. See [In-Place Archive is out of scope](../security.md#in-place-archive-is-out-of-scope).
:::

### atlas outlook quarantine

Move an unreadable Outlook manifest aside, so `list`, `status`, and `backup` stop reporting it and `restore`, `save`, `verify`, and `read` work again for the mailbox.

```bash
atlas outlook quarantine --key manifests/<owner-id>/<snapshot-id>.json
```

| Option                | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `--key <storage-key>` | Manifest key a command reported as unreadable (required) |
| `-t, --tenant <id>`   | Override the tenant ID from config                       |

See [Damaged manifests and version indexes](#damaged-manifests-and-version-indexes).

## atlas delete

Delete everything Atlas stored for a tenant, across every workload.

```bash
atlas delete --purge        # delete everything in the tenant bucket
atlas delete --purge -y     # skip the typed confirmation
```

| Option              | Description                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--purge`           | Delete all data, manifests, and encryption keys. Irreversible.                                                                                      |
| `-y, --yes`         | Skip the typed confirmation, for scheduled and scripted runs                                                                                        |
| `-t, --tenant <id>` | Override the tenant ID from config. The confirmation checks against this ID, and the purge targets that tenant's own bucket. |

::: danger A purge is irreversible
The purge sweeps the whole bucket rather than a fixed list of prefixes: Outlook, Contacts, Calendar, OneDrive, SharePoint, Teams, the identity registry, and any tree a later release adds. The encrypted data key at `_meta/dek.enc` is deleted last, and only once nothing else survives, so no ciphertext is left that can be neither restored nor confirmed erased. All data for the tenant becomes permanently inaccessible.
:::

- `atlas delete` without `--purge` exits non-zero and deletes nothing. For scoped deletes, use `atlas outlook delete`, `atlas contacts delete`, `atlas calendar delete`, `atlas onedrive delete`, `atlas sharepoint delete`, or `atlas teams delete`.
- Interactively, the purge asks you to type the tenant ID and aborts on any other input. Input that ends before a line is typed fails with exit `1`. Typing the ID catches a purge aimed at the wrong tenant; scoped deletes keep a single-keypress `y/n` prompt, so that `-y` is not needed everywhere.

  ```text
  [!] This will delete ALL data for tenant <tenant-id> across Outlook, Contacts, Calendar, OneDrive and SharePoint (data, manifests, encryption keys)
  Type the tenant ID to confirm:
  ```

- The purge is refused under `ATLAS_S3_BUCKET` set for another tenant.
- The purge takes the [tenant lease](#run-leases) after the confirmation and before its first write. It exits `12` when any owner of the tenant has a live lease, or when a backup, restore, deletion, or quarantine starts while it runs. A refusal writes nothing and removes its own lease. The confirmation comes first, so a purge that is going to be refused still asks for the tenant ID.
- Objects under Object Lock retention stay until retention ends and are reported as retained. See [Erasure](/security#erasure).

## Damaged manifests and version indexes

Move one damaged snapshot manifest, Teams snapshot index, or OneDrive or SharePoint version index out of the way, so later runs stop reporting it.

```bash
atlas onedrive status -o user@example.com          # names the damaged key, exits 9
atlas onedrive quarantine --key onedrive/manifests/<owner-id>/od-snap-1735689600000-a1b2c3.json
atlas onedrive backup -o user@example.com --full   # re-establish a complete newest snapshot
```

| Command                       | Accepts                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `atlas outlook quarantine`    | `manifests/{owner_id}/{snapshot_id}.json`                  |
| `atlas onedrive quarantine`   | `onedrive/manifests/...` and `onedrive/index/...` keys     |
| `atlas sharepoint quarantine` | `sharepoint/manifests/...` and `sharepoint/index/...` keys |
| `atlas contacts quarantine`   | `contacts/manifests/{owner_id}/{snapshot_id}.json`         |
| `atlas calendar quarantine`   | `calendar/manifests/{owner_id}/{snapshot_id}.json`         |
| `atlas teams quarantine`      | `teams/manifests/{team_id}/{snapshot_id}.json`             |

| Option                | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `--key <storage-key>` | Storage key a command reported as unreadable (required) |
| `-t, --tenant <id>`   | Override the tenant ID from config                      |

A manifest or version index is damaged when it exists but fails AES-256-GCM authentication, is not JSON, lacks the fields every such object carries, or names another owner or snapshot than its key. `status`, the listings, and every backup that reads it skip it, finish, print each key with the matching `quarantine` command, and exit `9`. Restores refuse only where skipping would change the answer. [Troubleshooting](../troubleshooting.md#damaged-manifests-and-version-indexes) has the per-command table and the recovery steps.

::: tip Schedule `verify` to find damage at rest
For Outlook, OneDrive, SharePoint, Contacts, and Calendar, `status`, `list -m`, `list-snapshots`, and the drive `stats` answer from the owner's [snapshot summary index](/operations/storage-layout#snapshot-summary-index). Outlook `list`, Outlook `stats`, and the logical bytes of `stats storage` read the same index. They decrypt only manifests the index has no row for, and `status` decrypts only the newest, so a manifest damaged after its row was written is not named by them. `verify` decrypts every manifest in the chain it checks.
:::

**What quarantine refuses:**

| Situation                                                                                                     | Result                                    |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Nothing is stored at the key                                                                                  | Exit `7`                                  |
| The object reads cleanly                                                                                      | Exit `7`, with `reads cleanly` in the message, so a typo never hides a healthy snapshot |
| The key is outside the workload's manifest or version index layout, has an empty, `.`, or `..` segment, or spells the owner another way | Exit `1`, before the tenant is opened |
| An object written by a newer Atlas format                                                                     | Refused; it is intact. Upgrade Atlas      |

**What the move does:**

- It copies the bytes unchanged to `_quarantine/{key}`, reads the copy back, and removes the original only when the two match. If an earlier quarantined copy of the same key exists, the new copy gets a millisecond suffix instead of overwriting it.
- The ciphertext stays bound to its original key, so the copy does not decrypt where it sits. To try it again, copy it back to the original key.
- Object Lock is respected. In a versioned bucket, removing the original writes a delete marker and the retained version stays, recoverable by version ID until retention ends. A backend that refuses the removal exits `8` (`ATLAS_OBJECT_LOCK_RETAINED`): the quarantined copy exists, the original stays in place, and commands keep naming it until retention allows the removal.

**What you lose, and what to run next:**

| Quarantined object                     | Effect                                                                                                                                         | Follow-up                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Outlook manifest                       | That run's changes drop out of every later point in time, because each manifest holds only its own run's changes. The command warns             | Run one `backup --full`, so the newest snapshot holds every current item again                                  |
| OneDrive or SharePoint manifest        | Same as Outlook                                                                                                                                | `backup --full` when newer snapshots exist. If the newest was quarantined, the next backup reads in full by itself and warns |
| Contacts or Calendar manifest          | Only that snapshot is lost; each snapshot is complete on its own. The mailbox's delta cursor is removed too                                     | None. The next backup reads every folder or calendar in full                                                    |
| Teams snapshot index                   | The next backup compares against the newest readable index. A channel whose cursor pointed at the quarantined index's shard is read in full     | None. Channels unchanged since the older index resume                                                          |
| OneDrive or SharePoint version index   | That run's versions leave `list-versions`, and `restore-version --before` can then pick an older version of those files. The command warns     | Check `list-versions` before a rollback                                                                         |

A drive delta cursor written before Atlas 7.0 records no snapshot. Until a 7.0 or later backup has run for that owner or site, run `backup --full` after any quarantine. A damaged Teams channel cursor is not quarantined: `status` names it in a warning, and the next backup reads that channel in full and rewrites the cursor.

## atlas contacts

Back up, restore, list, verify, and delete personal Outlook contacts per mailbox. Contacts are stored under the `contacts/` prefix of the tenant bucket (see [Contacts backup](/contacts-backup)).

```bash
atlas contacts backup -m user@example.com
atlas contacts backup -m user@example.com --full
atlas contacts restore -m user@example.com -s ct-snap-1735689600000-a1b2c3
atlas contacts restore -m user@example.com -s ct-snap-123 --target other@example.com
atlas contacts list -m user@example.com
atlas contacts verify -m user@example.com -s ct-snap-123
atlas contacts verify -m user@example.com -s ct-snap-123 --fast
atlas contacts delete -m user@example.com
atlas contacts delete -m user@example.com -s ct-snap-123
atlas contacts quarantine --key contacts/manifests/<mailbox-id>/<snapshot-id>.json
```

| Option                                       | Commands                                      | Description                                                                                                   |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `-m, --mailbox <email or id>`                | all except quarantine                         | Mailbox by email or Entra object ID (required)                                                                |
| `-s, --snapshot <id>`                        | restore, verify (required); delete (optional) | Snapshot identifier. On `delete` it removes one snapshot instead of every backup                              |
| `-T, --target <email or id>`                 | restore                                       | Target mailbox, defaults to the source mailbox                                                                |
| `--full`                                     | backup                                        | Ignore saved sync checkpoints and read every contact                                                          |
| `--retention-days <n>`, `--lock-mode <mode>` | backup                                        | Object Lock, as for `atlas outlook backup`. `--lock-mode` requires `--retention-days`                         |
| `--fast`                                     | verify                                        | Existence-only checks, no download or decrypt                                                                 |
| `-y, --yes`                                  | delete                                        | Skip the confirmation prompt                                                                                  |
| `-t, --tenant <id>`                          | all                                           | Tenant identifier (defaults to config)                                                                        |
| `--target-profile <name>`                    | restore                                       | Tenant profile for the writes. Requires `-T`                                                                  |
| `--key <storage-key>`                        | quarantine (required)                         | Storage key a command reported as unreadable. See [Damaged manifests](#damaged-manifests-and-version-indexes) |

- **Complete snapshots.** Each snapshot manifest is complete, so `restore` and `verify` read one manifest and no chain.
- **Restore never overwrites or deletes.** It tags each contact it creates with its source contact id, and skips an entry the target folder already holds as the original contact or as a tagged copy, counting it in `contacts_skipped`. Same-name contacts are restored separately, and a rerun creates nothing. Folders map by display-name path, compared without case. See [Contacts backup](/contacts-backup#restore).
- **`verify`** exits `1` when a check fails and `2` when interrupted. A full `verify` checks every object and lists each damaged one; other storage errors stop the run, as for [`atlas outlook verify`](#atlas-outlook-verify).
- **`delete -s`** removes the snapshot's manifest and the mailbox's delta cursor. The other snapshots stay whole, and the next backup reads every folder in full, so it captures again every change the deleted snapshot held. `delete -m` removes the cursor with the rest of the mailbox's data. A cursor left behind is resumed only while the snapshot it was saved with is still the newest readable one.

## atlas calendar

Back up, restore, list, verify, and delete Outlook calendars per mailbox. Calendars are stored under the `calendar/` prefix of the tenant bucket (see [Calendar backup](/calendar-backup)).

```bash
atlas calendar backup -m user@example.com
atlas calendar backup -m user@example.com --full
atlas calendar restore -m user@example.com -s cal-snap-1735689600000-a1b2c3
atlas calendar restore -m user@example.com -s cal-snap-123 --target other@example.com
atlas calendar list -m user@example.com
atlas calendar verify -m user@example.com -s cal-snap-123
atlas calendar verify -m user@example.com -s cal-snap-123 --fast
atlas calendar delete -m user@example.com
atlas calendar delete -m user@example.com -s cal-snap-123
atlas calendar quarantine --key calendar/manifests/<mailbox-id>/<snapshot-id>.json
```

| Option                                       | Commands                                      | Description                                                                                                   |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `-m, --mailbox <email or id>`                | all except quarantine                         | Mailbox by email or Entra object ID (required)                                                                |
| `-s, --snapshot <id>`                        | restore, verify (required); delete (optional) | Snapshot identifier. On `delete` it removes one snapshot instead of every backup                              |
| `-T, --target <email or id>`                 | restore                                       | Target mailbox, defaults to the source mailbox                                                                |
| `--full`                                     | backup                                        | Ignore saved sync checkpoints and re-read every calendar                                                      |
| `--retention-days <n>`, `--lock-mode <mode>` | backup                                        | Object Lock, as for `atlas outlook backup`. `--lock-mode` requires `--retention-days`                         |
| `--fast`                                     | verify                                        | Existence-only checks, no download or decrypt                                                                 |
| `-y, --yes`                                  | delete                                        | Skip the confirmation prompt                                                                                  |
| `-t, --tenant <id>`                          | all                                           | Tenant identifier (defaults to config)                                                                        |
| `--target-profile <name>`                    | restore                                       | Tenant profile for the writes. Requires `-T`                                                                  |
| `--key <storage-key>`                        | quarantine (required)                         | Storage key a command reported as unreadable. See [Damaged manifests](#damaged-manifests-and-version-indexes) |

- **Complete snapshots.** Each snapshot manifest is complete, so `restore` and `verify` read one manifest and no chain.
- **Restore never overwrites or deletes an event it did not create.** An event already in the target is skipped and counted in `events_skipped`. An event an earlier restore left incomplete (a failed attachment upload or recurrence change) is deleted and recreated in full.
- **No invitations.** Restored events carry no attendees, so no invitations are sent; the attendee list is written into the event body instead. See [why attendees are not re-invited](/calendar-backup#why-attendees-are-not-re-invited).
- **`verify`** exits `1` when a check fails and `2` when interrupted. A full `verify` checks every object and lists each damaged one; other storage errors stop the run, as for [`atlas outlook verify`](#atlas-outlook-verify).
- **`delete -s`** removes the snapshot's manifest and the mailbox's delta cursor. The other snapshots stay whole, and the next backup reads every calendar in full, so it captures again every change the deleted snapshot held. `delete -m` removes the cursor with the rest of the mailbox's data. A cursor left behind is resumed only while the snapshot it was saved with is still the newest readable one.

## atlas onedrive

Back up, restore, export, and verify OneDrive files per user. Files and manifests are stored under the `onedrive/` prefix of the tenant bucket (see [OneDrive backup](/onedrive-backup)).

```bash
atlas onedrive backup -o user@example.com
atlas onedrive list-snapshots -o user@example.com
atlas onedrive restore -o user@example.com -s od-snap-1735689600000-a1b2c3
```

| Subcommand        | Description                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `backup`          | Incremental backup. Use `--full` to ignore saved sync checkpoints.                                                                       |
| `restore`         | Restore files from a snapshot to the owner's or another user's OneDrive                                                                  |
| `save`            | Decrypt files from a snapshot into a local zip archive                                                                                   |
| `list-snapshots`  | List snapshot IDs and timestamps for the owner                                                                                           |
| `list-versions`   | List indexed versions of one file (`-f`, a file ID or path)                                                                              |
| `list-permissions` | List who had access to which file or folder, and folder colours, at a snapshot                                                          |
| `restore-version` | Push stored file versions back into the drive, one file or a whole rollback                                                              |
| `verify`          | Decrypt manifests and files for a snapshot, and check SHA-256 and index rows                                                             |
| `status`          | Report pending changes per drive, without backing up                                                                                     |
| `delete`          | Delete the owner's OneDrive backups, or one snapshot                                                                                     |
| `quarantine`      | Move an unreadable manifest or version index aside (see [Damaged manifests and version indexes](#damaged-manifests-and-version-indexes)) |

How drive snapshots work, for OneDrive and SharePoint alike:

- **Each snapshot holds one run's changes.** `restore`, `save`, and `verify` read the snapshot's **manifest chain**: the target manifest plus every older manifest for the same owner, merged newest first and deduplicated by drive item. Restoring the newest snapshot returns the whole drive as it stood at that time.
- **Deletions stick.** A file whose newest entry is a deletion (a tombstone) stays deleted, so a restore never brings back a file the user removed.
- **Full backups record deletions.** `--full`, a changed `--folder`, an expired sync checkpoint, and a sync checkpoint saved before sharing was captured all replace the incremental backup with a full listing of the drive, which shows only what currently exists. The last one keeps file tracking, so unchanged files are not downloaded again (see [First backup after upgrading](/onedrive-backup#first-backup-after-upgrading)). When the listing finishes, Atlas writes a tombstone for each stored file it did not return, within the re-read drive and the `--folder` scope when one is set. An interrupted run writes no tombstones, because a partial listing proves nothing about absence. SharePoint applies the same rule per document library.

::: tip Permissions
Backup and read operations need the application permissions `Files.Read.All` and `User.Read.All`. Restore also needs `Files.ReadWrite.All`.
:::

### atlas onedrive backup

Back up the files that changed in one user's OneDrive.

```bash
atlas onedrive backup -o user@example.com
atlas onedrive backup -o user@example.com --full
atlas onedrive backup -o user@example.com --folder /Projects
atlas onedrive backup -o user@example.com --retention-days 30 --lock-mode governance
```

| Option                 | Description                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `-o, --owner <id>`     | User email or Entra object ID (required)                                                            |
| `--full`               | Force a full backup, ignoring saved delta links                                                     |
| `--folder <path>`      | Back up only this folder and its subfolders (see below)                                             |
| `--retention-days <n>` | Lock every object this run writes for `n` days (see below)                                          |
| `--lock-mode <mode>`   | Object Lock mode, `governance` or `compliance` (default `governance`). Requires `--retention-days`. |
| `-t, --tenant <id>`    | Override the tenant ID from config                                                                  |

- **Progress.** A live dashboard shows one row per drive: fetching changes, then per-item progress with rate and ETA, then `[ok]` with stored, deduplicated, and version counts. An incremental run with no changes shows `[==] up to date`. Non-interactive runs (cron and CI) print one plain log line per finished drive.
- **`--folder`** filters what Atlas stores, not what Graph lists. The run still reads the whole drive's changes, but downloads, hashes, and writes only items inside the folder. A saved sync checkpoint records how far the whole **drive** was read, so changing `--folder` between runs, or switching between scoped and unscoped backups, forces a full re-read; repeated runs with the same value stay incremental. A scoped snapshot contains only that folder, so it does not replace a whole-drive backup unless the scope covers everything you need.
- **Ctrl+C** stops the run at once, wherever it is, including a file transfer, a Graph call, and any retry or throttle wait. The run exits `2` without advancing the delta cursor. The interrupted file is not recorded as a failed item, so it keeps its retry budget. A second Ctrl+C exits at once with status `130`.

::: details Object Lock for OneDrive and SharePoint
- Retention is stamped on each object the run writes: files, file versions, manifests, version indexes, and delta cursors. The retain-until date is computed once, when the run starts. The bucket's own Object Lock configuration is never changed, so two runs with different `--retention-days` each lock exactly what they wrote.
- The staging multipart upload for a large file is written without a lock. Its bytes are copied to a locked object and the staging copy is deleted. A bucket default retention still locks it.
- Versions before 6.1.0 set a bucket default retention instead. A default left by them stays in force until you remove it; see [Removing a bucket default retention](/self-hosting/storage#removing-a-bucket-default-retention). An explicit per-object date always takes precedence.
- The bucket must be created with Object Lock (see `atlas storage-check`). Otherwise the backup fails before it contacts Microsoft Graph: `ObjectLockVersioningDisabledError` when versioning is off, `ObjectLockUnsupportedError` when Object Lock is not enabled, or `ObjectLockModeRejectedError` when the backend refuses the mode.
- Small objects overwritten often, such as cursors and indexes, accumulate locked noncurrent versions until retention expires. The bucket housekeeping lifecycle rules remove them afterwards.

See [Erasure](/security#erasure) and [Immutability and Object Lock](/operations/immutability).
:::

### atlas onedrive restore

Restore files from a OneDrive snapshot to the owner's or another user's OneDrive.

```bash
atlas onedrive restore -o user@example.com -s od-snap-1735689600000-a1b2c3
atlas onedrive restore -o user@example.com -s od-snap-123 --destination /DR-drill
atlas onedrive restore -o user@example.com -s od-snap-123 --in-place
atlas onedrive restore -o user@example.com -s od-snap-123 --target-owner other@example.com
atlas onedrive restore -o user@example.com -s od-snap-123 --conflict replace
atlas onedrive restore -o user@example.com -s od-snap-123 --in-place --restore-permissions
atlas onedrive restore -o user@example.com -s od-snap-123 --file-filter "/Documents/report.docx" --name report-restored.docx
```

| Option                     | Description                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID (required)                                      |
| `-s, --snapshot <id>`      | Snapshot to restore from (required)                                           |
| `--target-owner <id>`      | Restore to another user's OneDrive (defaults to the owner)                    |
| `--destination <path>`     | Folder to restore under, created if missing (default: `/Restore-<timestamp>`) |
| `--in-place`               | Restore to the original paths instead of a restore root                       |
| `--name <filename>`        | Rename the restored file. Rejected unless exactly one file matches.           |
| `--file-filter <paths...>` | Restore only specific files, by ID or path                                    |
| `-c, --conflict <mode>`    | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`)      |
| `--restore-permissions`    | Reapply captured grants and recreate sharing links (default: off)             |
| `-t, --tenant <id>`        | Override the tenant ID from config                                            |
| `--target-profile <name>`  | Tenant profile for the writes. Requires `--target-owner`.                     |

- **Where files land.** A restore nests under `/Restore-<timestamp>` at the target drive root and recreates the original folders beneath it. `--in-place` writes back over the original paths. It is never the default, because repeated in-place restores with `--conflict rename` create suffixed duplicates among live content. See [Where restored files land](/onedrive-backup#where-restored-files-land).
- **Several drives.** Each manifest entry records the drive its file came from. A restore to the original owner returns each file to its drive, and a file whose drive no longer exists is reported and skipped, never written to a different drive. `--target-owner` has no drive mapping, because Atlas records drive IDs and not drive names, so it is refused when the snapshot spans more than one drive. Restore those to the original owner, or one drive at a time with `--file-filter`.
- **Sharing.** Without `--restore-permissions` no permission is applied, and the summary shows how many were left out. With it, direct grants are reapplied with no invitation email and links are recreated with the same type and scope. A permission that cannot be restored, such as a grant to a user deleted since the backup, is listed with its reason and does not change the exit code. See [Restoring sharing](/onedrive-backup#restoring-sharing).
- **Folder colours.** Never written, because Microsoft Graph refuses the write. The summary shows `Folder colours not restored` with a count, which does not change the exit code. See [Folder colours](/onedrive-backup#folder-colours).
- **`--file-filter` paths** are the rooted paths shown in a listing. A file at the root is `/Report.docx`, not `//Report.docx`. Version commands accept the same path forms.
- **Unmatched `--file-filter`.** On `restore` and `save`, for OneDrive and SharePoint: when no value matches, the command stops with `ATLAS_NOT_FOUND` (exit `7`) after reading the snapshot and before any Graph listing or write, so no file or archive is written. When some values match, it restores or saves those, names each unmatched value, and exits `2`, whether or not a file also failed. A value selects every file whose ID or full path it names.
- **Ctrl+C.** An upload already sent is never cut off, because Microsoft 365 may already have committed it; that file counts as restored if it was accepted. A large file stopped before its final chunk is not created. The run prints the files restored so far and exits `2`, and a file stopped before it was written is not reported as failed. A second Ctrl+C exits at once with status `130`, so the file in flight may or may not exist: check the destination before retrying, especially with `--in-place`. This applies to `atlas sharepoint restore` and to `restore-version` on both drives. Upload sizes and session cleanup are under [File transfers](/operations/reliability#file-transfers-onedrive-and-sharepoint).

::: details Upload limits behind the interrupt rules
A file up to 4 MiB is one upload request. A larger file goes through an upload session, and its final chunk is the request that creates it. When Ctrl+C stops a larger file before that chunk, Atlas deletes the upload session, giving the delete 10 s. A session Atlas cannot delete expires on Graph's side without creating a file.
:::

### atlas onedrive save

Save decrypted files from a snapshot to a local zip archive that keeps the folder structure.

```bash
atlas onedrive save -o user@example.com -s od-snap-1735689600000-a1b2c3
atlas onedrive save -o user@example.com -s od-snap-123 --output ~/Downloads/backup.zip
atlas onedrive save -o user@example.com -s od-snap-123 --file-filter "/Documents/report.docx"
atlas onedrive save -o user@example.com -s od-snap-123 --skip-verify
```

| Option                     | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID (required)       |
| `-s, --snapshot <id>`      | OneDrive snapshot ID (required)                |
| `--file-filter <paths...>` | Save only specific files, by ID or path        |
| `--output <path>`          | Output zip file path (default: auto-generated) |
| `-y, --yes`                | Overwrite an existing output without asking    |
| `--skip-verify`            | Skip SHA-256 integrity checks                  |
| `-t, --tenant <id>`        | Override the tenant ID from config             |

```text
onedrive-od-snap-123-2026-05-24T14-30-00.zip
  Documents/
    report.docx
    budget.xlsx
  Photos/
    vacation.jpg
```

- Each file is SHA-256 verified after decryption unless `--skip-verify` is set.
- Atlas writes the archive to a temporary file beside the output path and moves it into place only when complete. A failed save leaves no partial archive, and an existing file at the output path is untouched until a successful run replaces it.
- If `--output` names an existing file, Atlas asks `Overwrite? [Y/n]` before it contacts Graph or reads storage. Answering `n` exits `0` and leaves the file as it was. With stdin at EOF the question gets no answer, so the command exits `1`. `-y` overwrites without asking, for scheduled jobs.
- Files larger than 4 MiB are decrypted as a stream straight into the archive entry, so memory does not grow with file size. Each such file is read from storage twice: once to verify it, once to write it. See [Nothing is released before it authenticates](../security.md#nothing-is-released-before-it-authenticates).

### atlas onedrive list-snapshots

List the owner's snapshot IDs and timestamps.

```bash
atlas onedrive list-snapshots -o user@example.com
```

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override the tenant ID from config       |

### atlas onedrive list-versions

List the stored versions of one file.

```bash
atlas onedrive list-versions -o user@example.com -f "Documents/report.docx"
```

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-f, --file <ref>`  | Graph file ID or drive path (required)   |
| `-t, --tenant <id>` | Override the tenant ID from config       |

### atlas onedrive list-permissions

List who had access to which file or folder at a snapshot.

```bash
atlas onedrive list-permissions -o user@example.com
atlas onedrive list-permissions -o user@example.com -s od-snap-123
```

| Option                | Description                              |
| --------------------- | ---------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | Snapshot to list (default: the newest)   |
| `-t, --tenant <id>`   | Override the tenant ID from config       |

- Prints one row per captured permission: the item's path, its kind, the roles, and the grantee or the link's type and scope with any expiry.
- Only an item's own permissions are captured, so an item that only inherits access from its folder is not listed.
- It reads the backup alone and makes no Graph call.
- A snapshot taken before sharing was captured records no permissions, so it lists nothing.
- A second table lists each coloured folder with its colour as stored: `palette 6`, plus `tag` and `emoji` when those columns are set. It is left out when no folder is coloured, which includes every snapshot taken before folder colours were captured.

### atlas onedrive restore-version

Push stored file versions back into the drive: roll one file back past a bad edit, or a whole folder back past a mass encrypt-and-sync event.

```bash
atlas onedrive restore-version -o user@example.com -f "Documents/report.docx" --version 3.0
atlas onedrive restore-version -o user@example.com --before 2026-03-10T00:00:00Z
atlas onedrive restore-version -o user@example.com --before 2026-03-10T00:00:00Z --path /Projects --in-place
```

| Option              | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required)                                  |
| `-f, --file <ref>`  | Graph file ID or drive path. Required with `--version`.                   |
| `--version <id>`    | Exact stored version, as shown in the `Version` column of `list-versions` |
| `--before <iso>`    | Restore each file's newest version at or before this instant              |
| `--path <prefix>`   | Limit a `--before` rollback to this folder and below                      |
| `--in-place`        | Upload over the original file instead of writing a copy beside it         |
| `-t, --tenant <id>` | Override the tenant ID from config                                        |

::: warning Nothing is overwritten unless you ask
By default the restore writes a sibling such as `report (restored 2026-03-01T08-15-00Z).docx` and leaves the live file untouched, so you can inspect the rollback before adopting it. `--in-place` uploads over the original path. Even then the earlier content is kept, because Microsoft 365 records the upload as a new version and keeps the replaced one in the file's version history.
:::

- Use either `--file` with `--version`, or `--before`. `--version` alone is rejected, because a version ID is unique only within one file. `--path` cannot be combined with `--file`.
- Restored files keep the modification time the version had, so a rolled-back document does not look as though it was authored during the incident.
- A file with no version at or before the cutoff is **reported, not skipped silently**, and counts toward the skipped total. Treat that list as outstanding work: those files have no pre-incident copy in the backup.
- Exit codes follow snapshot `restore`: `0` when every file was rolled back, `2` when a file failed or was skipped or Ctrl+C stopped the rollback, and `5` when the passphrase does not unwrap the data key. A damaged stored version fails only its own file.
- Atlas uploads the bytes it stored and verified, rather than calling Graph's `restoreVersion`. That call works only on versions Microsoft 365 still holds, so it fails after a retention policy trims history, a file is deleted, or a library is removed, and its result cannot be checked against the manifest checksum.
- `restore-version` does not accept `--target-profile`; it writes into the source tenant.

### atlas onedrive verify

Decrypt a snapshot's manifests and files, and check SHA-256 checksums and index rows.

```bash
atlas onedrive verify -o user@example.com -s od-snap-1735689600000-a1b2c3
```

| Option                | Description                              |
| --------------------- | ---------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | OneDrive snapshot ID (required)          |
| `-t, --tenant <id>`   | Override the tenant ID from config       |

Failed objects and storage errors are classified as in [`atlas outlook verify`](#atlas-outlook-verify).

### atlas onedrive status

Report pending file changes and failed files per drive, without backing up.

```bash
atlas onedrive status -o user@example.com
```

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override the tenant ID from config       |

The command replays the saved delta links from the delta cursor and writes nothing. The columns are described under [Status columns](#drive-status-columns).

### atlas onedrive delete

Delete the owner's OneDrive backups, or the newest snapshot, behind the same confirmation prompt as the Outlook delete.

```bash
atlas onedrive delete -o user@example.com -s od-snap-123
atlas onedrive delete -o user@example.com -y
```

| Option                | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required)                              |
| `-s, --snapshot <id>` | Delete the owner's newest snapshot instead of every backup, see below |
| `-y, --yes`           | Skip the confirmation prompt                                          |
| `-t, --tenant <id>`   | Override the tenant ID from config                                    |

- Without `-s`, the command removes the owner's `manifests`, `data`, `index`, `_meta`, and `staging` prefixes. Staging is included so an interrupted large-file upload leaves no content behind in the bucket.
- With `-s`, the owner's newest snapshot manifest, the delta cursor, and the snapshot's row in the [summary index](/operations/storage-layout#snapshot-summary-index) are removed. The files stay, because other snapshots may reference them.

#### Deleting one drive snapshot {#drive-snapshot-delete}

`-s` behaves the same for OneDrive and SharePoint:

- **Only the newest snapshot is accepted.** Every newer snapshot is built on the chain before it, so deleting an older one would drop the files it recorded from every later snapshot and bring back the ones it recorded as deleted. Atlas refuses that with `SnapshotNotNewestError` (`ATLAS_SNAPSHOT_NOT_NEWEST`, exit `11`) and deletes nothing. Delete the newer ones first, newest first, or delete the whole backup by leaving out `-s`.
- **A damaged manifest blocks the delete.** A manifest's creation time is inside its ciphertext, so the order cannot be checked while one of the owner's or site's manifests is unreadable. The delete exits `9` and names it; move it aside with [`quarantine`](#damaged-manifests-and-version-indexes) and retry. Checking the order decrypts the manifests, so `delete -s` needs the encryption passphrase and the tenant's data key.
- **The next backup reads every drive or library in full.** It lists every file that exists, stores an entry for each, and records a deletion for each file the remaining snapshots list that is gone. Unchanged content is not uploaded again, because each unique file is stored once. A cursor left behind anyway, for example by an interrupted delete, is resumed only while the snapshot it was saved with still exists; otherwise the backup reads in full and says so in a warning.
- **The run's version index stays.** `index/{owner}/runs/{snapshot}.json` holds the historical file versions captured during that run. The full run that follows does not fetch versions of a file whose content is already stored, so deleting the index would lose them. `list-versions` and `restore-version` keep offering them.

A snapshot deleted with a release before 7.0 left its cursor behind, and those cursors record no snapshot. If you deleted the newest snapshot of an owner or site that way and other snapshots remain, run one `backup --full` for it.

## atlas sharepoint

Back up, restore, export, and verify SharePoint document library files per site. Files and manifests live under the `sharepoint/` prefix of the tenant bucket. The site can be given as a URL or a Graph site ID (see [Identifiers](#identifiers)).

Snapshots work as for OneDrive: `restore`, `save`, and `verify` read the full manifest chain for the site, with the same tombstone and merge rules described under [`atlas onedrive`](#atlas-onedrive).

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint quarantine --key sharepoint/manifests/<site-id>/sp-snap-1735689600000-a1b2c3.json
```

| Subcommand        | Description                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `backup`          | Incremental backup. Use `--full` to ignore saved sync checkpoints.                                                                       |
| `list-sites`      | List every site the tenant search returns, with its kind: `site`, or `container (not backed up)` for a SharePoint Embedded container     |
| `list-snapshots`  | List all SharePoint snapshots for a site                                                                                                 |
| `list-versions`   | List all backed-up versions of one file                                                                                                  |
| `list-permissions` | List who had access to which file or folder, and folder colours, at a snapshot                                                          |
| `restore-version` | Push stored file versions back into the library, one file or a whole rollback                                                            |
| `restore`         | Restore files from a snapshot to the site's document libraries                                                                           |
| `save`            | Decrypt files from a snapshot into a local zip archive                                                                                   |
| `verify`          | Decrypt manifests and files for a snapshot, and check SHA-256 and index rows                                                             |
| `status`          | Report pending changes per document library, without backing up                                                                         |
| `delete`          | Delete the site's SharePoint backups, or one snapshot                                                                                    |
| `quarantine`      | Move an unreadable manifest or version index aside (see [Damaged manifests and version indexes](#damaged-manifests-and-version-indexes)) |

::: tip Permissions
Backup and verification need the application permissions `Sites.Read.All` and `Files.Read.All`. Restore also needs `Sites.ReadWrite.All`.
:::

### atlas sharepoint list-sites

List every site the tenant search returns, and whether Atlas can back it up.

```bash
COLUMNS=200 atlas sharepoint list-sites
```

| Option              | Description                        |
| ------------------- | ---------------------------------- |
| `-t, --tenant <id>` | Override the tenant ID from config |

### atlas sharepoint backup

Back up the files that changed in one site's document libraries.

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --include-subsites
```

| Option                 | Description                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `--site <url-or-id>`   | SharePoint site URL or Graph site ID (required)                                                     |
| `--full`               | Force a full backup, ignoring saved delta links                                                     |
| `--include-subsites`   | Also back up every subsite beneath the site, one snapshot per subsite                               |
| `--retention-days <n>` | Lock every object this run writes for `n` days (same semantics as OneDrive)                         |
| `--lock-mode <mode>`   | Object Lock mode, `governance` or `compliance` (default `governance`). Requires `--retention-days`. |
| `-t, --tenant <id>`    | Override the tenant ID from config                                                                  |

Subsites are separate sites. By default a backup covers only the named site and warns once for each subsite it does not cover, so a classic site collection never looks fully protected while subsites sit outside the backup.

- **`--include-subsites`** backs up the whole tree. Atlas walks it explicitly, because Graph's `GET /sites/{site-id}/sites` returns only direct subsites. Traversal stops at 20 levels. Each subsite gets its own snapshot under its own `site_id` prefix (`sharepoint/manifests/{site_id}/...`), with the same structure as a root-site backup, so you restore a subsite by naming it.
- **Subsite listing failures.** Graph returns only the subsites the application can read. With `--include-subsites`, a subsite whose listing fails (for example `403`) is an error naming its parent site, and the run prints `Status: UNHEALTHY` and exits `2`, so an access gap never narrows the scope silently. Without the flag, the same failure stays a warning, because no subsite is in scope.
- **Fatal failures during the listing.** A rejected token (`401`) ends the run with exit `4`. A `429` or a Graph outage that outlasts the retry budget ends it with exit `3` before any library is listed, so one outage costs one retry budget. Ctrl+C during the listing ends it as an interrupt with exit `2`.

### atlas sharepoint list-snapshots

List all SharePoint snapshots for a site.

```bash
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
```

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>`  | Override the tenant ID from config              |

### atlas sharepoint list-versions

List all backed-up versions of one file.

```bash
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering -f /Documents/report.docx
```

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-f, --file <ref>`   | File ID or path (required)                      |
| `-t, --tenant <id>`  | Override the tenant ID from config              |

### atlas sharepoint list-permissions

List who had access to which file or folder at a snapshot.

```bash
atlas sharepoint list-permissions --site https://contoso.sharepoint.com/sites/Engineering
```

| Option                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | Snapshot to list (default: the newest)          |
| `-t, --tenant <id>`   | Override the tenant ID from config              |

Output matches [`atlas onedrive list-permissions`](#atlas-onedrive-list-permissions), including the table of coloured folders. Site and library permissions are not captured.

### atlas sharepoint restore-version

Push stored file versions back into the library they were captured from, one file or a whole rollback.

```bash
atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering -f /Documents/report.docx --version 3.0
atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering --before 2026-03-10T00:00:00Z
```

| Option               | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required)                   |
| `-f, --file <ref>`   | File ID or path. Required with `--version`.                       |
| `--version <id>`     | Exact stored version, as shown by `list-versions`                 |
| `--before <iso>`     | Restore each file's newest version at or before this instant      |
| `--path <prefix>`    | Limit a `--before` rollback to this folder and below              |
| `--in-place`         | Upload over the original file instead of writing a copy beside it |
| `-t, --tenant <id>`  | Override the tenant ID from config                                |

Behaviour matches [`atlas onedrive restore-version`](#atlas-onedrive-restore-version), including copy-by-default placement, flag rules, exit codes, and the upload of stored bytes instead of Graph's `restoreVersion`.

### atlas sharepoint restore

Restore files from a snapshot to the site's document libraries, or to another site.

```bash
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --destination /DR-drill
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --target-site https://contoso.sharepoint.com/sites/Recovery
```

| Option                      | Description                                                                   |
| --------------------------- | ----------------------------------------------------------------------------- |
| `--site <url-or-id>`        | SharePoint site URL or Graph site ID (required)                               |
| `-s, --snapshot <id>`       | SharePoint snapshot ID (required)                                             |
| `--target-site <url-or-id>` | Restore to a different site (defaults to the original)                        |
| `--destination <path>`      | Folder to restore under, created if missing (default: `/Restore-<timestamp>`) |
| `--in-place`                | Restore to the original paths instead of a restore root                       |
| `--name <filename>`         | Rename the restored file. Rejected unless exactly one file matches.           |
| `--file-filter <paths...>`  | Restore only specific files, by ID or path                                    |
| `-c, --conflict <mode>`     | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`)      |
| `--restore-permissions`     | Reapply captured grants and recreate sharing links (default: off)             |
| `-t, --tenant <id>`         | Override the tenant ID from config                                            |
| `--target-profile <name>`   | Tenant profile for the writes. Requires `--target-site`.                      |

- Restored files nest under `Restore-<timestamp>` in each destination library, with the original structure beneath it. `--in-place` writes over the original paths. See [Where restored files land](../sharepoint-backup.md#where-restored-files-land).
- With `--target-site`, each file goes to the target library with the same name as its source library. A restore from a single library goes to the target's only library. Any ambiguous case is refused: the file is skipped, the candidate libraries are listed, and the command exits non-zero. Atlas never writes into the source library instead. See [Where a cross-site restore lands](../sharepoint-backup.md#where-a-cross-site-restore-lands).
- `--restore-permissions` behaves as for [`atlas onedrive restore`](#atlas-onedrive-restore). With `--target-site`, reapplied permissions share the copy in the target site with the original audience.
- `--file-filter` matching, Ctrl+C, and the `Folder colours not restored` count behave as for [`atlas onedrive restore`](#atlas-onedrive-restore).

### atlas sharepoint save

Save decrypted files from a SharePoint snapshot to a local zip archive that keeps the library folder structure.

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --output ~/Downloads/backup.zip
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --file-filter "/Documents/report.docx"
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --skip-verify
```

| Option                     | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `--site <url-or-id>`       | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>`      | SharePoint snapshot ID (required)               |
| `--file-filter <paths...>` | Save only specific files, by ID or path         |
| `--output <path>`          | Output zip file path (default: auto-generated)  |
| `-y, --yes`                | Overwrite an existing output without asking     |
| `--skip-verify`            | Skip SHA-256 integrity checks                   |
| `-t, --tenant <id>`        | Override the tenant ID from config              |

- Each file is SHA-256 verified after decryption unless `--skip-verify` is set.
- If `--output` names an existing file, Atlas asks `Overwrite? [Y/n]` before it contacts Graph or reads storage. Answering `n` exits `0` and leaves the file as it was. With stdin at EOF the question gets no answer, so the command exits `1` and the file is untouched. `-y` overwrites without asking, for scheduled jobs.

### atlas sharepoint verify

Decrypt a snapshot's manifests and files, and check SHA-256 checksums and index rows.

```bash
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

| Option                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required)               |
| `-t, --tenant <id>`   | Override the tenant ID from config              |

Failed objects and storage errors are classified as in [`atlas outlook verify`](#atlas-outlook-verify).

### atlas sharepoint status

Report pending file changes and failed files per document library, without backing up.

```bash
atlas sharepoint status --site https://contoso.sharepoint.com/sites/Engineering
```

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>`  | Override the tenant ID from config              |

#### Status columns {#drive-status-columns}

OneDrive and SharePoint status report the same columns:

| Column    | Meaning                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Pending` | Files the next backup would store or mark deleted. Folders and the drive root are not counted, because backup skips them. The count is exact |
| `Failed`  | Files of this drive in the list of failed files, waiting for a retry or permanently skipped after 5 attempts                                  |

- A drive is up to date only when both columns are `0`. A file in the failed list is missing from the backup even when nothing new is pending, because Microsoft 365 never re-presents an unchanged item. A failed entry for a drive that no longer exists still counts toward the overall verdict.
- When the delta cursor has outlived the snapshot it was saved with, the next backup reads in full instead of resuming it, so status does not replay it either. Every drive is then reported as not backed up and not up to date.
- A Graph `401` or a missing-grant `403` stops the command with exit `4` (`ATLAS_AUTH_DENIED`). A SharePoint site Graph refuses while the root site is readable stops it with exit `4` and `ATLAS_ACCESS_REFUSED`. Any other failure, including a drive refused that way, marks the drive `peek failed` with the error class and message, and the owner or site is reported as not up to date.

### atlas sharepoint delete

Delete the site's SharePoint backups, or the newest snapshot, behind a confirmation prompt.

```bash
atlas sharepoint delete --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint delete --site https://contoso.sharepoint.com/sites/Engineering -y
```

| Option                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required)                 |
| `-s, --snapshot <id>` | Delete the site's newest snapshot instead of every backup       |
| `-y, --yes`           | Skip the confirmation prompt                                    |
| `-t, --tenant <id>`   | Override the tenant ID from config                              |

Without `-s`, the command removes the site's `manifests`, `data`, `index`, `_meta`, and `staging` prefixes. With `-s`, the site's newest snapshot manifest, the delta cursor, and the snapshot's row in the [summary index](/operations/storage-layout#snapshot-summary-index) are removed, and the shared files stay. Any other snapshot is refused with exit `11`, and the next backup reads every library in full. See [Deleting one drive snapshot](#drive-snapshot-delete).

## atlas teams

Back up Microsoft Teams channel messages, replies, membership, and tabs per team, and export a snapshot as a zip archive. Restore is not yet available. Files and manifests live under the `teams/` prefix of the tenant bucket, and a team is named by its Graph team ID. See [Teams backup](../teams-backup.md).

```bash
atlas teams list-teams
atlas teams backup --all
atlas teams status
atlas teams quarantine --key teams/manifests/<team-id>/<snapshot-id>.json
```

| Subcommand       | Description                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `list-teams`     | List the teams the application can read                                                                   |
| `backup`         | Incremental backup of one, several, or all teams. Exits `2` when any team is unhealthy                    |
| `list-snapshots` | List Teams snapshots for one team                                                                         |
| `verify`         | Check the snapshot's index, channel shards, and every object it references                                |
| `save`           | Export one snapshot, or one channel of it, as a zip archive                                               |
| `status`         | Show the newest snapshot for each team: creation time and ID                                              |
| `delete`         | Delete one team's Teams backups, or one snapshot                                                          |
| `quarantine`     | Move an unreadable snapshot index aside (see [Damaged manifests](#damaged-manifests-and-version-indexes)) |

::: tip Permissions
Teams backup uses eight Application permissions. `Files.Read.All` reads each channel's files folder location. `ChannelMessage.Read.All` is a protected API that may need Microsoft approval. See [Azure AD setup](../azure-ad-setup.md#teams-application-permissions).
:::

### atlas teams list-teams

List the teams the application can read, with the ID to pass to `--team`.

```bash
atlas teams list-teams
```

| Option              | Description                        |
| ------------------- | ---------------------------------- |
| `-t, --tenant <id>` | Override the tenant ID from config |

### atlas teams backup

Back up channel messages for one, several, or all teams.

```bash
atlas teams backup --team <team-id>
atlas teams backup --team <team-id> --team <other-team-id>
atlas teams backup --all
atlas teams backup --team <team-id> --channel <channel-id>
atlas teams backup --all --concurrency 8
```

| Option                 | Description                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--team <id>`          | Team to back up. Repeat for several teams                                                                                        |
| `--all`                | Back up every team the application can read                                                                                      |
| `--channel <id>`       | Back up only this channel. Requires exactly one `--team`, not allowed with `--all`. Others carry forward                         |
| `--full`               | Force a full read: ignores saved delta links and cached files folders, and rebuilds a channel whose previous shard is unreadable |
| `--concurrency <n>`    | Channels backed up at once within a team, 1 to 16 (default 4). Requests stay paced, see [Pacing](../teams-backup.md#pacing)      |
| `--retention-days <n>` | Lock every object this run writes for `n` days (same semantics as OneDrive)                                                      |
| `--lock-mode <mode>`   | Object Lock mode, `governance` or `compliance` (default `governance`). Requires `--retention-days`                               |
| `-t, --tenant <id>`    | Override the tenant ID from config                                                                                               |

- **`-t` must be the tenant GUID** for Teams. A domain exits `6` (`ATLAS_CONFIG_INVALID`) before any Graph call.
- **Exit `2` when any team is unhealthy:** a channel error, a failed root still listed, an interrupted run, or a team whose listed channels were all owned by another tenant. See [Failed channels](../teams-backup.md#failed-channels).
- **A permanently skipped root** keeps its team unhealthy until a forced read (`atlas teams backup --team <team-id> --full`) clears its entry.
- **A channel whose previous shard is missing or damaged** fails with exit `2` until a `--full` run rebuilds it from Microsoft 365. See [Unreadable channel shards](../teams-backup.md#unreadable-channel-shards).
- **An unreadable index newer than the latest readable one** is damaged storage, not a failed channel. The run finishes against the older index, names the key with the `atlas teams quarantine` command, and exits `9`, unless a failure in the same run already chose `2`.
- **Ctrl+C** stops the run and exits `2`. The interrupted root is not recorded as a failed attempt, and messages already stored are kept. The interrupted channel keeps its previous delta link and its checkpoint, so the next run resumes its read. A second Ctrl+C exits at once with status `130`, before the run writes its index.

### atlas teams list-snapshots

List the Teams snapshots of one team.

```bash
atlas teams list-snapshots --team <team-id>
```

| Option              | Description                        |
| ------------------- | ---------------------------------- |
| `--team <id>`       | Team ID (required)                 |
| `-t, --tenant <id>` | Override the tenant ID from config |

- Snapshot indexes Atlas cannot read are skipped and named with their keys and the `atlas teams quarantine` command, and the command exits `9`.
- Indexes written by a newer Atlas format are named in a warning that says to upgrade Atlas, and the command exits `9` (`ATLAS_FORMAT_UNSUPPORTED`). They are intact, so no quarantine command is printed. See [Unreadable snapshots](../teams-backup.md#unreadable-snapshots).

### atlas teams verify

Check a snapshot's index, channel shards, and every object it references.

```bash
atlas teams verify --team <team-id> -s <snapshot-id>
```

| Option                | Description                        |
| --------------------- | ---------------------------------- |
| `--team <id>`         | Team ID (required)                 |
| `-s, --snapshot <id>` | Snapshot to verify (required)      |
| `-t, --tenant <id>`   | Override the tenant ID from config |

Exits `1` when any object is missing, fails its check, or is a shard written by a newer format.

### atlas teams save

Write one snapshot, or one channel of it, as a zip archive that opens in a browser.

```bash
atlas teams save --team <team-id> -s <snapshot-id> --output <path>
atlas teams save --team <team-id> -s <snapshot-id> --channel <channel-id> --output <path>
```

| Option                | Description                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `--team <id>`         | Team ID (required)                                                                        |
| `-s, --snapshot <id>` | Snapshot to save (required)                                                               |
| `--channel <id>`      | Save only this channel. The archive then lists only that channel                          |
| `--output <path>`     | Zip file to write. Default `teams-<snapshot-id>-<timestamp>.zip` in the current directory |
| `-y, --yes`           | Overwrite an existing output file without asking                                          |
| `-t, --tenant <id>`   | Override the tenant ID from config                                                        |

- The command reads storage only and makes no Graph calls. See [Teams backup](../teams-backup.md#save) for the archive layout.
- It exits `1` when a message or hosted file could not be read, and `2` when hosted content the backup never captured is missing from the archive, or Ctrl+C stopped the export. The summary lists each missing item.
- If `--output` names an existing file, Atlas asks `Overwrite? [Y/n]` before it reads storage. Answering `n` exits `0` and leaves the file as it was. With stdin at EOF the question gets no answer, so the command exits `1` and the file is untouched. `-y` overwrites without asking, for scheduled jobs.

### atlas teams status

Show the newest readable snapshot of every team.

```bash
atlas teams status
```

| Option              | Description                        |
| ------------------- | ---------------------------------- |
| `-t, --tenant <id>` | Override the tenant ID from config |

- Each row shows the team's newest readable snapshot, its channel count, `Failed roots`, and `Pending rechecks`. See [Failed channels](../teams-backup.md#failed-channels) for what those counts mean.
- A damaged snapshot index of any team is named with the `atlas teams quarantine` command, and the command exits `9`. An index or cursor written by a newer Atlas format is named with a warning to upgrade, and the command also exits `9`.
- A damaged channel cursor is a warning only, because the next backup rewrites it.

### atlas teams delete

Delete one team's Teams backups, or one snapshot, behind a confirmation prompt.

```bash
atlas teams delete --team <team-id> -s <snapshot-id>
atlas teams delete --team <team-id> -y
```

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `--team <id>`         | Team ID (required)                                |
| `-s, --snapshot <id>` | Delete only this snapshot instead of every backup |
| `-y, --yes`           | Skip the confirmation prompt                      |
| `-t, --tenant <id>`   | Override the tenant ID from config                |

- Without `-s`, the command removes all backed-up data for the team, in the order cursors, indexes, channel shards, then message objects, and then the quarantined copies of its indexes under `_quarantine/`.
- With `-s`, only that snapshot's index is deleted. Its shards and message objects stay, because later snapshots can reference them.
- To set aside an index that `list-snapshots` cannot read, use `atlas teams quarantine`, which keeps its bytes for inspection instead of destroying them.

## atlas storage-check

Check whether the bucket can hold immutable backups and keep concurrent runs apart, without running a backup.

```bash
atlas storage-check
atlas storage-check --lock-mode governance --retention-days 30
atlas storage-check --lock-mode compliance --retention-days 365
```

| Option                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `--lock-mode <mode>`   | Planned Object Lock mode (`governance` or `compliance`) |
| `--retention-days <n>` | Planned retention period in days                        |
| `-t, --tenant <id>`    | Override the tenant ID from config                      |

The command reports versioning, Object Lock status, the bucket class, and conditional-write support. It checks the effective bucket, including a [bucket override](/configuration#bucket-override), and exits `1` when the bucket is not ready, so it can gate scheduled jobs.

| Bucket class              | Meaning                                                |
| ------------------------- | ------------------------------------------------------ |
| `lock-capable`            | Can take retention policies                            |
| `versioned-only (legacy)` | Predates v2.1.0 auto-provisioning                      |
| `unversioned (legacy)`    | Predates v2.1.0 auto-provisioning                      |

Legacy buckets need the [migration runbook](/self-hosting/storage#migrating-a-legacy-bucket) before immutability can be used.

The `Conditional writes` row reports a probe of the two writes that keep concurrent runs apart: a create-only write (`If-None-Match: *`) onto an existing object, and a compare-and-swap (`If-Match`) with a stale ETag. Both must be refused with `412`. The owner lease, the data key bootstrap, and the identity registry depend on it.

| Value        | Meaning                                                                                                                       | Exit code |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------- |
| `supported`  | Both writes were refused                                                                                                      | Unchanged |
| `IGNORED`    | The backend accepted at least one of them, and the row names which. Two runs on one owner are then not kept apart. Upgrade or replace the backend | `1`       |
| `not probed` | The probe object could not be written: the bucket does not exist yet, or the credentials are read-only. The row gives the reason | Unchanged |

- **The probe is the only write.** It puts one plaintext object of a few bytes under `_meta/storage-check/` and deletes it, with its versions, before the command returns. It needs `s3:PutObject` and `s3:DeleteObject` on that prefix. On a bucket with a default retention the probe's versions stay until that retention ends.
- **Bucket default retention.** On a lock-capable bucket the command also reports the bucket's default retention. Atlas does not set one, because it would lock every object written without its own retention: backups without `--retention-days`, and the staging uploads Atlas deletes after copying them. A default found here was left by a version before 6.1.0 or set by hand. It is shown in yellow and does not change the exit code. See [Removing a bucket default retention](/self-hosting/storage#removing-a-bucket-default-retention).
- **Lifecycle rules.** The command names each missing action in the enabled Atlas rules. The read requires `s3:GetLifecycleConfiguration`. If the configuration cannot be read, the row reports `not checked` with the reason. The row is advisory and does not affect the exit code.

## atlas stats

Show storage statistics for Outlook, OneDrive, and SharePoint backups: snapshot counts, item counts (messages or files), encrypted storage size, and a monthly breakdown.

```bash
atlas stats                            # all services
atlas stats --service outlook          # Outlook bucket-level overview only
atlas stats -m user@example.com        # Outlook mailbox-level breakdown
atlas stats -o user@example.com        # OneDrive statistics for one owner
atlas stats --site https://contoso.sharepoint.com/sites/Engineering   # one site
atlas stats --top 5                    # limit owner and site tables to 5 rows
atlas stats --json                     # raw JSON output
```

| Option                        | Description                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Outlook statistics for one mailbox (implies `--service outlook`)              |
| `-o, --owner <email\|id>`     | OneDrive statistics for one owner (implies `--service onedrive`)              |
| `--site <url\|id>`            | SharePoint statistics for one site (implies `--service sharepoint`)           |
| `--service <name>`            | Limit output to `outlook`, `onedrive`, `sharepoint`, or `all` (default `all`) |
| `--top <n>`                   | Maximum owner or site rows in the OneDrive and SharePoint tables (default 20) |
| `--json`                      | Output raw JSON instead of formatted tables                                   |
| `-t, --tenant <id>`           | Override the tenant ID from config                                            |

- Use only one of `--mailbox`, `--owner`, or `--site` at a time. Each scopes the output to its service. `--owner` accepts an email or a raw object ID. `--site` accepts a site URL or a composite site ID.
- The statistics come from the encrypted snapshot manifests in the bucket. The only Graph call happens when `-m`, `-o`, or `--site` is given as an address or URL; pass an object ID or site ID to make none.
- The OneDrive and SharePoint sections list per-owner and per-site rollups (snapshots, files, size, last backup time), largest first.
- With several services, `--json` returns an object keyed by service name. With one service, it returns that service's stats object. Log lines from identity lookup go to stderr, so stdout carries only the JSON.

### atlas stats storage

Measure the bytes the tenant bucket physically holds, by listing it.

```bash
atlas stats storage                                   # the tenant bucket, per workload
atlas stats storage --by owner --top 10               # the ten largest owners and sites
ATLAS_S3_ENDPOINT=https://replica.example.com atlas stats storage   # a replica
ATLAS_S3_BUCKET=contoso-replica atlas stats storage                  # a copy under another name
atlas stats storage --max-requests 1000 --json        # stop after 1,000 requests, print a token
atlas stats storage --continue <token> --json         # resume from that token
```

| Option               | Description                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `--by <breakdown>`   | `workload` (default) or `owner`, which adds one row per mailbox, OneDrive owner, or site |
| `--max-requests <n>` | Stop after this many S3 requests and print a continuation token                          |
| `--continue <token>` | Resume a measurement from its continuation token                                         |
| `--top <n>`          | Maximum owner rows with `--by owner` (default 20)                                        |
| `--json`             | Output raw JSON instead of formatted tables                                              |
| `-t, --tenant <id>`  | Override the tenant ID from config                                                       |

`atlas stats` reports logical sizes from the manifests. `atlas stats storage` reports what the bucket stores and a provider bills: current and noncurrent versions, delete markers, staging objects, and incomplete multipart uploads, per workload and optionally per owner. See [Storage usage](/operations/storage-usage) for what each figure means and what a run costs in list requests.

- The JSON output includes `totals`, `by_workload`, `stored_bytes`, `list_requests`, and `complete`. It includes `by_owner` with `--by owner`, and `logical_bytes_referenced` on a complete run with readable manifests.
- If the credentials cannot list versions, multipart uploads, or their parts, the report says so in `versions_visible` and `incomplete_uploads_visible`. The affected columns show `n/a`, and the stored totals become a lower bound.
- A run that fails on an S3 error prints a continuation token to stderr, so the next run resumes where it stopped. The token is bound to the S3 endpoint, region, and bucket name, and is refused on another.
- The command is read-only. It creates no bucket and no key material. To measure a replica, point `ATLAS_S3_ENDPOINT` and the keys at it, and set `ATLAS_S3_BUCKET` when its name differs.
- `-t`, `--top`, and `--json` are shared with `atlas stats` and can appear before or after `storage`.

## atlas list-users

List the users recorded in the identity registry, which backups populate.

```bash
atlas list-users
atlas list-users -t <tenant-id>
```

| Option              | Description                        |
| ------------------- | ---------------------------------- |
| `-t, --tenant <id>` | Override the tenant ID from config |

The output has two tables, active users and recycled users, each listing Email, Object ID, Display Name, and Since. When the registry is empty, the command prints:

```text
No users registered yet. Run a backup to populate the registry.
```

## atlas keys

Manage the data keys of every tenant profile. The encryption passphrase is shared by every profile, so both subcommands cover every profile's tenant by default.

```bash
atlas keys rewrap                         # every profile: re-wrap under the configured passphrase, current KDF parameters
atlas keys rewrap --new-passphrase        # every profile: prompt for a new passphrase, twice, with no echo
atlas keys rewrap --new-passphrase < new.txt                    # non-interactive rotation
atlas keys rewrap --old-passphrase        # finish a rotation after the configured passphrase already changed
atlas keys purge-old-wrappers --old-passphrase                  # delete the old wrappers once the rotation is done
```

| Subcommand                | Description                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `keys rewrap`             | Re-wrap `_meta/dek.enc` of every profile's tenant under a new passphrase, current KDF parameters, or both |
| `keys purge-old-wrappers` | Delete the noncurrent versions of `_meta/dek.enc` that a re-wrap left behind                              |

Passphrases are prompted for, never accepted as flag values, which keeps them out of shell history and the process table. The new passphrase is asked twice and the old one once. When input is piped, one flag reads stdin whole. With both `--old-passphrase` and `--new-passphrase`, stdin must hold exactly two lines: the old passphrase, then the new one.

Both subcommands take each tenant's [tenant lease](#run-leases). A tenant with a live owner lease is reported as `busy, skipped`, and owner commands of a tenant exit `12` while it is being processed.

### keys rewrap

Re-wrap each tenant's data key under a new passphrase or the current KDF parameters, without re-encrypting any data.

```bash
atlas keys rewrap --new-passphrase
atlas keys rewrap -t <tenant-id> --new-passphrase --allow-partial
```

| Option              | Description                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--new-passphrase`  | Prompt for a new passphrase. Omit it to re-wrap under the configured one                                          |
| `--old-passphrase`  | Prompt for the passphrase the keys are still wrapped under. Use it when the configured passphrase already changed |
| `-t, --tenant <id>` | Re-wrap one tenant only. With `--new-passphrase` it also needs `--allow-partial`                                  |
| `--allow-partial`   | Allow `--tenant` to change the passphrase of one tenant while other profiles stay under the old one               |

The data key does not change. Nothing in the bucket is re-encrypted, every snapshot stays readable, and each tenant costs one object write. The key derived from the passphrase (the KEK) is derived again from the new passphrase and a fresh salt, under the current KDF parameters. Running the command with no flags brings tenants set up with weaker scrypt parameters up to date.

::: danger This rotates the wrapper, not the data key
Re-wrapping answers a **leaked passphrase**. It does not answer a compromised bucket. If the data key or the plaintext has already been captured, a new passphrase does not help, because the attacker no longer needs the passphrase. A replica does not help either, since it holds ciphertext under the same key. A compromised data key requires a new bucket and a fresh backup. See [Rotating the data key](/security#rotating-the-data-key).
:::

::: warning The old passphrase stays valid until the replaced version is gone
Atlas buckets are versioned. A re-wrap writes a new current `_meta/dek.enc` and keeps the version it replaced, which still opens with the old passphrase. Run [`atlas keys purge-old-wrappers`](#keys-purge-old-wrappers) once the rotation is complete. See [Old wrapper versions](/security#old-wrapper-versions).
:::

**Which tenants are covered.** The tenant of every profile in the encrypted config store and in `atlas.config.json`, plus the tenant this run resolved. A tenant listed twice is re-wrapped once. Each tenant is opened in its own bucket, so a profile's [bucket override](/configuration#bucket-override) applies to that profile's tenant only. Under `ATLAS_S3_BUCKET`, every tenant but the run's is reported as `failed`, so the run is not complete and the passphrase is not retired. Tenants run one after another, so a busy tenant is reported and skipped rather than stopping the rest.

Each tenant gets one result:

| Result                        | Meaning                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `re-wrapped`                  | The key opened with the old passphrase and now opens with the new one                            |
| `already re-wrapped`          | The key already opens with the new passphrase. Nothing was written                               |
| `no key yet`                  | The tenant has no bucket or no key. Its first backup creates one under the configured passphrase |
| `neither passphrase opens it` | Nothing was written. Check the passphrase, or pass `--old-passphrase`                            |
| `busy, skipped`               | Another operation holds the tenant or one of its owners. Nothing was written                     |
| `failed`                      | The re-wrap of that tenant stopped with the error printed below the table                        |

The run is complete when every tenant is `re-wrapped`, `already re-wrapped`, or `no key yet`. Only then is the old passphrase retired:

| Where the passphrase came from | What a complete run does                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| The encrypted config store     | Writes the new passphrase there and reads it back                            |
| `ATLAS_ENCRYPTION_PASSPHRASE`  | Writes nothing. Prints that the variable must be changed where it is defined |
| `atlas.config.json`            | Writes nothing. Prints the path of the file to change                        |

- **Any other result exits `2`**, writes no configuration, and names every tenant still under the old passphrase. Keep the old passphrase, fix what the table reports, and run the same command again. A rerun recognises tenants already under the new passphrase and skips them.
- **Finishing after a manual change.** If the configured passphrase was changed by hand before every tenant finished, run `atlas keys rewrap --old-passphrase` to move the rest to the configured one.
- **One tenant only.** `--tenant` with `--new-passphrase` is refused unless `--allow-partial` is given, and the refusal names the profiles that would be left behind. After the configured passphrase changes, every command for those profiles fails with exit `5` until they are re-wrapped. A run with `--allow-partial` always exits `2` and never writes the configuration. `--tenant` without `--new-passphrase` refreshes the KDF parameters of that tenant only and needs no extra flag.
- **Safety checks.** Atlas first checks which passphrase opens each stored key, so a wrong passphrase fails before anything is written. After the write, it reads the key back and unwraps it with the new passphrase, and a tenant counts as re-wrapped only when the key that comes back matches the key that went in. See [Rewrapping the passphrase](/security#rewrapping-the-passphrase) for what happens when that check fails.

::: details How a refused write is reported
Atlas classifies a failed write by the response's HTTP status and S3 error code, never by its message text.

| Response                                  | Reported as                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| HTTP `412` or `PreconditionFailed`        | Another run changed `_meta/dek.enc` during the re-wrap. The tenant fails without overwriting it      |
| HTTP `403` or `AccessDenied`              | `_meta/dek.enc` is under Object Lock retention, so the write is refused until retention expires. The tenant is reported as `failed`, with a message that the stored key is unchanged, rather than a bare access denial that looks like a credentials fault |
| Anything else, such as a `500`            | The storage error it is                                                                             |
:::

### keys purge-old-wrappers

Delete the old versions of each tenant's wrapped data key once a rotation is complete.

```bash
atlas keys purge-old-wrappers --old-passphrase      # asks for the old passphrase, then for confirmation
atlas keys purge-old-wrappers -y --old-passphrase < old.txt   # scripted
```

| Option              | Description                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `--old-passphrase`  | Prompt for the previous passphrase, so an old version can be proven to hold the same data key |
| `-t, --tenant <id>` | Purge one tenant only                                                                         |
| `-y, --yes`         | Skip the confirmation. Required when the old passphrase is piped on stdin                     |

The command lists the versions of `_meta/dek.enc` in each tenant bucket and deletes the noncurrent ones that hold the current data key. It never deletes the current version.

- A tenant is refused, with nothing deleted, unless the configured passphrase opens its current wrapper. That proves the re-wrap finished and the configuration was switched.
- Each noncurrent version is unwrapped with the configured passphrase and the one given with `--old-passphrase`. Only a version that unwraps to the same data key as the current one is deleted:

| Version result | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| deleted        | It held the current data key and is gone                                                  |
| retained       | Object Lock or a bucket policy refused the delete. Governance retention is never bypassed |
| unverified     | No supplied passphrase opens it. Rerun with `--old-passphrase`                            |
| different key  | It holds another data key, which may still protect retained data. It is kept              |
| failed         | Reading or deleting it failed. The error is printed                                       |

- A storage backend whose version listing does not name exactly one current version gets nothing deleted, and the tenant is reported as `failed`.
- When `_meta/dek.enc` has no current version, for example behind a delete marker, its old versions are reported as `unverified` and kept, because there is no current key to compare them with.
- The command exits `0` only when no old wrapper is left in any covered bucket, and `2` otherwise.
- Deleting versions needs `s3:ListBucketVersions`, `s3:GetObjectVersion`, and `s3:DeleteObjectVersion`.

::: warning The old versions are the only way back
Run the purge only after the configured passphrase was switched and a backup or restore succeeded with it.
:::

## atlas config

Manage shared settings in an encrypted local store.

```bash
atlas config set s3.endpoint https://s3.example.com   # set and validate
atlas config set s3.access-key <access-key>
pbpaste | atlas config set s3.secret-key -            # "-" reads from stdin, keeping it out of shell history
atlas config get s3.secret-key                        # secrets are masked
atlas config list                                     # all shared keys, values, and sources
atlas config unset s3.access-key                      # remove from the store
atlas config validate                                 # HeadBucket on the effective bucket
```

| Subcommand                 | Description                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `config set <key> <value>` | Validate and save a value to the encrypted store. `-` reads the value from stdin.          |
| `config get <key>`         | Print the effective value. Secrets are masked.                                             |
| `config list`              | Print every shared key with its value and source (`env`, `secure store`, or `config file`) |
| `config unset <key>`       | Remove a key from the encrypted store                                                      |
| `config validate`          | Print the effective bucket and send it `HeadBucket`. Exits non-zero on failure.            |

| Key                     | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `s3.endpoint`           | S3 endpoint URL. Must use `http` or `https`.                           |
| `s3.access-key`         | S3 access key                                                          |
| `s3.secret-key`         | S3 secret key. Masked.                                                 |
| `s3.region`             | S3 region. Lowercase letters, digits, and dashes. Default `us-east-1`. |
| `encryption.passphrase` | Tenant encryption passphrase. Masked. At least 14 UTF-8 bytes.         |

- **Storage.** Values are written to `~/.atlas/config.enc` (AES-256-GCM). The store key lives in the OS keyring (macOS Keychain or libsecret), so credentials are never stored in plaintext on disk. See [Configuration](../configuration.md) for precedence and [Security](../security.md) for the threat model.
- **Validation.** Each value is format-checked on save. When the S3 group is complete, its live probe runs automatically. `ATLAS_*` environment variables still override stored values, and the command warns when a saved value is shadowed by one.
- **Refused keys.** `tenant.id`, `client.id`, and `client.secret` are refused with a message that points to [`atlas tenants add`](#atlas-tenants). `bucket` and `s3.bucket` are refused too: a bucket belongs to one tenant, so it is set with `atlas tenants add --bucket` or `ATLAS_S3_BUCKET`. See [Bucket override](/configuration#bucket-override).
- **`config validate`** checks S3 only. It prints the selected profile's effective bucket, `atlas-<tenant-id>` or the override, and sends it `HeadBucket`, which bucket-scoped keys can call where `ListBuckets` is often denied. A missing derived bucket passes, because the first backup creates it. A missing overridden bucket fails, because Atlas never creates one. With no tenant ID configured, it falls back to `ListBuckets`. Use `atlas tenants validate` for Microsoft Graph.
- Each subcommand documents itself, for example `atlas config set --help`.

## atlas tenants

Manage named tenant profiles. A profile holds one Microsoft Entra app registration (tenant ID, client ID, and client secret) in the encrypted store at `~/.atlas/config.enc`.

```bash
pbpaste | atlas tenants add contoso --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas tenants list
atlas tenants use contoso                 # active profile for later runs
atlas tenants validate                    # Graph token for the selected profile
atlas tenants validate --all              # every profile
pbpaste | atlas tenants add contoso-replica --tenant-id <tenant-id> --client-id <client-id> --client-secret - --bucket contoso-replica
atlas --profile fabrikam outlook backup -m john.doe@example.com
atlas tenants remove fabrikam -y
```

| Subcommand                | Description                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants add <name>`      | Save a profile, then check its Graph credentials. A failed check keeps the profile and exits `1`                                                                  |
| `tenants list`            | List the stored profiles with masked secrets, and each profile's bucket when one is set. The selected profile is marked with `*`                                  |
| `tenants use <name>`      | Set the active profile for later runs when neither `--profile` nor `ATLAS_PROFILE` is set                                                                         |
| `tenants remove <name>`   | Delete a profile from the store. Removing the active profile needs `-y`, and no profile is active afterward                                                       |
| `tenants validate [name]` | Check a profile's Graph credentials, then print its effective bucket and send it `HeadBucket`. Without a name, checks the selected profile                         |

| Option                    | Command  | Description                                                                                                                                              |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tenant-id <id>`        | add      | Microsoft Entra tenant: a GUID, or a domain such as `contoso.onmicrosoft.com` (required)                                                                 |
| `--client-id <id>`        | add      | Application (client) ID of the app registration. Must be a GUID (required)                                                                               |
| `--client-secret <value>` | add      | Client secret. A single token with no whitespace. Pass `-` to read it from stdin (required)                                                              |
| `--bucket <name>`         | add      | Bucket to use instead of `atlas-<tenant-id>`, such as a provider replica. Never created by Atlas. See [Bucket override](/configuration#bucket-override). |
| `--replace`               | add      | Overwrite an existing profile with the same name. A bucket the new command omits is removed.                                                             |
| `-y, --yes`               | remove   | Required to remove the active profile                                                                                                                    |
| `--all`                   | validate | Validate every profile instead of one                                                                                                                    |

- Select a profile per run with the global [`--profile`](#global-options) flag or `ATLAS_PROFILE`. See [Tenant profiles](/configuration#tenant-profiles).
- Profile names are lowercase letters, digits, and dashes, up to 32 characters.
- Prefer `--client-secret -`: a value passed on the command line can appear in shell history and the process list.
- `tenants validate` exits `1` if a check fails, and `6` before any check when a partial `ATLAS_*` Graph override changes the selected profile's tenant or client ID (see [Configuration](/configuration#tenant-profiles)).
