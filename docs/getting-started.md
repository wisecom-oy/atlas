---
description: Install the Atlas CLI or SDK, connect object storage and your Microsoft 365 tenant, and run your first backup on Node.js 22.12 or later.
---

# Getting started

Install the CLI, connect it to object storage and your Microsoft 365 tenant, and run your first backup. The CLI requires Node.js 22.12 or later. The SDK requires Node.js 22.8 or later.

<script setup>
import { GETTING_STARTED } from './.vitepress/theme/terminal-sessions';
</script>

<CliTerminal :sessions="GETTING_STARTED" label="Example run of the commands in this guide, with mock data" />

## Install

Atlas ships as two npm packages built on the same engine:

| Package                  | Install                             | Best for                                                                                    |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| **`@wisecom/atlas-cli`** | `npm install -g @wisecom/atlas-cli` | Shell operations, cron and systemd jobs, operator workflows. Reads `.env` automatically.    |
| **`@wisecom/atlas-sdk`** | `npm add @wisecom/atlas-sdk`        | Node.js applications, custom schedulers, multi-tenant services. Explicit config, typed API. |

This guide uses the CLI. A local install also provides the `atlas` command: a postinstall hook links it onto your `PATH`, and warns if an alias or another command already uses the name. See the [CLI reference](/reference/cli).

With Bun, run `bun pm -g trust @wisecom/atlas-cli` after installing. Bun blocks install scripts for untrusted packages, so the link step does not run otherwise.

## Start an S3-compatible backend

Atlas writes backups to any S3-compatible object store. For local development and testing, start MinIO with the Docker Compose file in the repository:

```bash
cd docker
cp .env.example .env && chmod 600 .env
openssl rand -hex 32    # set the output as MINIO_ROOT_PASSWORD in .env
docker compose up -d
```

Compose refuses to start until `MINIO_ROOT_PASSWORD` is set. MinIO listens on `127.0.0.1` only: port **9000** for the S3 API and port **9001** for the web console. Use `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` as the S3 access key and secret key below. For production storage, see the [self-hosting guide](./self-hosting/).

## Configure credentials

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

| Variable                      | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| `ATLAS_TENANT_ID`             | Microsoft Entra tenant ID                            |
| `ATLAS_CLIENT_ID`             | App registration client ID                           |
| `ATLAS_CLIENT_SECRET`         | App registration client secret                       |
| `ATLAS_S3_ENDPOINT`           | S3 endpoint URL, for example `http://localhost:9000` |
| `ATLAS_S3_ACCESS_KEY`         | S3 access key                                        |
| `ATLAS_S3_SECRET_KEY`         | S3 secret key                                        |
| `ATLAS_ENCRYPTION_PASSPHRASE` | Passphrase that protects the encryption keys         |

All seven are required, from `.env` or from the encrypted store below. The first three come from a Microsoft Entra app registration, described in [Microsoft Entra ID setup](./azure-ad-setup.md). For every other option, and for how `.env`, environment variables, and flags interact, see [Configuration](./configuration.md).

Instead of `.env`, you can keep values in the CLI's encrypted local store. Shared settings use `atlas config set <key> <value>`, for example `atlas config set s3.endpoint <endpoint>`. Each app registration is a named tenant profile:

```bash
atlas tenants add <name> --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas config list
atlas tenants list
```

::: danger Protect your passphrase
The encryption passphrase cannot be recovered. Atlas has no reset mechanism and no recovery key. If the passphrase is lost, the backups stay encrypted and cannot be read. Store it in a password manager or secrets vault, and confirm you can retrieve it before you rely on the backups. See [Security](./security.md) for the encryption model.
:::

## Run your first backup

Back up one mailbox, one OneDrive, or one SharePoint site:

```bash
# Outlook mailbox
atlas outlook backup --mailbox user@example.com

# OneDrive for one user
atlas onedrive backup -o user@example.com

# SharePoint site
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
```

The first run is a full backup: Atlas downloads and encrypts every message, attachment, or file. Later runs are [incremental](./operations/delta-sync.md) and transfer only what changed.

To get the mailboxes to loop over in a scheduler, run `atlas outlook mailboxes`. It reads the list live from Microsoft 365.

Contacts, calendars, and Teams have their own guides: [Contacts](./contacts-backup.md), [Calendar](./calendar-backup.md), and [Teams](./teams-backup.md).

## Check and browse backups

```bash
# Check whether a mailbox backup is up to date (no backup runs)
atlas outlook status -m user@example.com

# List backed-up mailboxes, then the snapshots for one mailbox
atlas outlook list
atlas outlook list -m user@example.com

# List OneDrive and SharePoint snapshots
atlas onedrive list-snapshots -o user@example.com
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
```

## Restore

Restore writes data back to Microsoft 365. Try it on a non-production target first, and grant the write permissions listed in [Microsoft Entra ID setup](./azure-ad-setup.md).

```bash
# Restore the Inbox of a mailbox into a test mailbox
atlas outlook restore -m user@example.com -f Inbox -T test-user@example.com

# Save a mailbox as an EML zip archive instead of restoring it
atlas outlook save -m user@example.com --output backup.zip
```

Without `-T`, Atlas restores into the source mailbox. For OneDrive and SharePoint, see the [OneDrive backup](./onedrive-backup.md) and [SharePoint backup](./sharepoint-backup.md) guides. Every command and option is in the [CLI reference](./reference/cli.md).

## Use the SDK

To drive Atlas from your own application, such as a backup portal or a multi-tenant scheduler, install the SDK:

```bash
npm add @wisecom/atlas-sdk
```

The SDK exposes the same workloads as the CLI, one namespace per workload. It does not read `.env`, so pass configuration when you create the instance:

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

// Outlook: same as `atlas outlook backup`
const mailbox = await atlas.outlook.backup('user@example.com');

// OneDrive: same as `atlas onedrive backup`
const drive = await atlas.onedrive.backup('<owner-id>');

// SharePoint: same as `atlas sharepoint backup`. Returns one result per backed-up site.
const [site] = await atlas.sharepoint.backup('https://contoso.sharepoint.com/sites/Engineering');
```

`createAtlasInstance` validates the configuration at once. A missing field or a passphrase shorter than the minimum throws a `ConfigError`.

## See also

- [Concepts](./concepts.md): how snapshots, encryption, and storage fit together
- [Configuration](./configuration.md): every option and environment variable
- [Security](./security.md): the encryption and threat model
- [Troubleshooting](./troubleshooting.md)
- [CLI reference](./reference/cli.md)
- [SDK reference](./reference/sdk.md) and [SDK examples](./reference/examples.md): full method list and production patterns
