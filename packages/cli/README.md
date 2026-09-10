# @wisecom/atlas-cli

Command-line tool for [Atlas](https://github.com/wisecom-oy/atlas). Secure Microsoft 365 backup and restore to S3-compatible object storage.

Protects Outlook mailboxes, OneDrive files, and SharePoint document libraries with per-tenant envelope encryption (AES-256-GCM), content-addressed deduplication, and incremental delta sync via Microsoft Graph.

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

## Quick start

Configure credentials in a `.env` file (see [Configuration](https://wisecom-oy.github.io/atlas/configuration)):

```bash
cp .env.example .env
```

Run your first backup:

```bash
# Outlook, single mailbox
atlas outlook backup --mailbox user@company.com

# OneDrive
atlas onedrive backup -o user@company.com

# SharePoint
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
```

## Common commands

| Command | Description |
| ------- | ----------- |
| `atlas outlook backup` | Back up mailboxes to object storage |
| `atlas outlook restore` | Restore from a snapshot |
| `atlas outlook verify` | Verify snapshot integrity |
| `atlas onedrive backup` | Back up a user's OneDrive |
| `atlas sharepoint backup` | Back up a SharePoint site |
| `atlas stats` | Storage statistics |
| `atlas storage-check` | Validate S3 Object Lock readiness |
| `atlas replicate` | Replicate snapshots to a secondary target |

Run `atlas --help` or `atlas <command> --help` for full flag reference.

## Exit codes

v5 preserves `0` for success, `1` for unclassified or command-reported failure, and `2` for partial results. Fatal failures now use `3` for retryable network/throttle errors, `4` for auth/licensing, `5` for a wrong passphrase, `6` for configuration, `7` for a missing resource and `8` for retention.

Treat every nonzero code as a failure or incomplete run. Fatal diagnostics go to stderr and include both the Atlas category and the underlying provider details. See the [exit-code reference](https://wisecom-oy.github.io/atlas/reference/cli#exit-codes) and [v5 migration guide](https://wisecom-oy.github.io/atlas/migration/v5#cli-failure-exit-codes) before updating scheduled jobs.

## Programmatic use

For embedding Atlas in Node.js applications, use [`@wisecom/atlas-sdk`](https://www.npmjs.com/package/@wisecom/atlas-sdk) instead.

## Documentation

Full guides, security model, and CLI reference:

**https://wisecom-oy.github.io/atlas/**

## License

Code is licensed under Apache-2.0, Copyright 2026 [Wisecom Oy](https://wisecom.fi).

The Atlas and Wisecom names and logos are trademarks of Wisecom Oy and are not covered by that licence. See [`assets/LICENSE.md`](https://github.com/wisecom-oy/atlas/blob/main/assets/LICENSE.md) in the repository.
