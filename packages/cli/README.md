[![Atlas, the open-source Microsoft 365 backup engine by Wisecom](https://raw.githubusercontent.com/wisecom-oy/atlas/main/assets/og-card.jpg)](https://docs.atlas.wisecom.fi)

# @wisecom/atlas-cli

**The command-line tool for Atlas, the open-source Microsoft 365 backup engine by [Wisecom](https://wisecom.fi).**

**[Documentation](https://docs.atlas.wisecom.fi)** · [Quickstart](https://docs.atlas.wisecom.fi/getting-started) · [CLI reference](https://docs.atlas.wisecom.fi/reference/cli) · [GitHub](https://github.com/wisecom-oy/atlas) · [Wisecom Continuity](https://wisecom.fi/en/products/continuity)

Atlas backs up Microsoft 365 to S3-compatible object storage that you control, and restores from it.

Atlas protects Outlook mailboxes, personal Outlook contacts, Outlook calendars, OneDrive files, SharePoint document libraries, and Teams channel messages. Each tenant's data is encrypted with its own key (AES-256-GCM envelope encryption), each unique item is stored once, and after the first run only changes are fetched from Microsoft 365.

## Requirements

- Node.js 22.12 or later

## Install

```bash
npm install -g @wisecom/atlas-cli
```

Beta releases use the `beta` dist-tag:

```bash
npm install -g @wisecom/atlas-cli@beta
```

With Bun, run `bun pm -g trust @wisecom/atlas-cli` after installing. Bun blocks install scripts for untrusted packages, which skips the postinstall hook that links `atlas` onto your `PATH`.

## Quick start

Configure storage and the encryption passphrase in a `.env` file (see [Configuration](https://docs.atlas.wisecom.fi/configuration)), then store each Microsoft 365 tenant's app registration as a tenant profile:

```bash
cp .env.example .env
atlas tenants add contoso --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas tenants validate
```

`--client-secret -` reads the secret from stdin. For a single tenant, `ATLAS_TENANT_ID`, `ATLAS_CLIENT_ID`, and `ATLAS_CLIENT_SECRET` in `.env` still work, and they override the selected profile.

Run your first backup:

```bash
# Outlook, single mailbox
atlas outlook backup --mailbox user@example.com

# OneDrive
atlas onedrive backup -o user@example.com

# Contacts
atlas contacts backup -m user@example.com

# Calendar
atlas calendar backup -m user@example.com

# SharePoint
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering

# Teams
atlas teams backup --team <team-id>
```

## Common commands

| Command                   | Description                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| `atlas tenants add`       | Store a tenant profile; select one per run with `--profile`         |
| `atlas outlook backup`    | Back up mailboxes to object storage                                 |
| `atlas outlook restore`   | Restore from a snapshot                                             |
| `atlas outlook verify`    | Verify snapshot integrity                                           |
| `atlas onedrive backup`   | Back up a user's OneDrive                                           |
| `atlas contacts backup`   | Back up a mailbox's personal contacts                               |
| `atlas calendar backup`   | Back up a mailbox's Outlook calendars                               |
| `atlas sharepoint backup` | Back up a SharePoint site                                           |
| `atlas teams backup`      | Back up Teams channel messages to object storage                    |
| `atlas stats`             | Storage statistics                                                  |
| `atlas stats storage`     | Physical bytes in the bucket: versions, staging, incomplete uploads |
| `atlas storage-check`     | Check Object Lock, conditional writes, and lifecycle rules; `--apply-lifecycle` adds or repairs them |

Run `atlas --help` or `atlas <command> --help` for every flag.

## Exit codes

Treat every nonzero code as a failed or incomplete run.

| Code | Meaning                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                                     |
| `1`  | Unclassified or command-reported failure                                                                    |
| `2`  | Partial result                                                                                              |
| `3`  | Retryable network or throttling failure, including an S3 endpoint that never answered                       |
| `4`  | Authentication or licensing                                                                                 |
| `5`  | Wrong passphrase                                                                                            |
| `6`  | Invalid configuration                                                                                       |
| `7`  | Resource not found                                                                                          |
| `8`  | Blocked by retention                                                                                        |
| `9`  | Stored content cannot be read back, including a damaged snapshot manifest, Teams snapshot index, or version index that a command skipped and named |
| `11` | Newer snapshots depend on the one requested; delete them first                                              |
| `12` | Another Atlas operation holds the same mailbox, drive owner, site, or team. Nothing was written; retry later |

For code `9`, `atlas <workload> quarantine --key <key>` moves the damaged object aside. Fatal diagnostics go to stderr with both the Atlas category and the underlying provider details. Read the [exit-code reference](https://docs.atlas.wisecom.fi/reference/cli#exit-codes) before updating scheduled jobs, and the [v7 migration guide](https://docs.atlas.wisecom.fi/migration/v7) before upgrading.

## Programmatic use

To embed Atlas in a Node.js application, use [`@wisecom/atlas-sdk`](https://www.npmjs.com/package/@wisecom/atlas-sdk).

## Documentation

Everything else lives at **[docs.atlas.wisecom.fi](https://docs.atlas.wisecom.fi)**:

| Topic                                 |                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| First backup, step by step            | [Quickstart](https://docs.atlas.wisecom.fi/getting-started)               |
| Microsoft Entra ID permissions        | [Entra ID app registration](https://docs.atlas.wisecom.fi/azure-ad-setup) |
| Every command and flag                | [CLI reference](https://docs.atlas.wisecom.fi/reference/cli)              |
| Storage, scheduling, and replicas     | [Self-hosting](https://docs.atlas.wisecom.fi/self-hosting/)               |
| Encryption and threat model           | [Security model](https://docs.atlas.wisecom.fi/security)                  |
| Fixing a failed run                   | [Troubleshooting](https://docs.atlas.wisecom.fi/troubleshooting)          |

## Wisecom Continuity

Atlas is free to run yourself, with no licence key and no feature gating. If you would rather not operate backups, Wisecom runs Atlas as a managed service: [Wisecom Continuity](https://wisecom.fi/en/products/continuity), with automated onboarding and monitoring and self-service restore. Both use the same open engine and the same storage format.

## License

Code is licensed under Apache-2.0, Copyright 2026 [Wisecom Oy](https://wisecom.fi).

The Atlas and Wisecom names and logos are trademarks of Wisecom Oy and are not covered by that licence. See [`assets/LICENSE.md`](https://github.com/wisecom-oy/atlas/blob/main/assets/LICENSE.md) in the repository.
