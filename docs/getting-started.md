# Getting started

Install the CLI, connect it to object storage and your Microsoft 365 tenant, and run your first backup. The CLI requires Node.js 22.12 or later. The SDK requires Node.js 22.8 or later.

## Install

Atlas ships as two npm packages built on the same engine:

| Package                  | Install                             | Best for                                                                                 |
| ------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **`@wisecom/atlas-cli`** | `npm install -g @wisecom/atlas-cli` | Shell operations, cron and systemd jobs, operator workflows. Reads `.env` automatically. |
| **`@wisecom/atlas-sdk`** | `npm add @wisecom/atlas-sdk`        | Node.js applications, custom schedulers, multi-tenant services. Explicit config, typed API. |

This guide uses the CLI. A local install also provides an `atlas` command. A postinstall hook links it onto your `PATH` and prints a warning if the name is already taken by an alias or another command. See the [CLI reference](/reference/cli) for details.

If you install with Bun, run `bun pm -g trust @wisecom/atlas-cli` afterwards. Bun blocks install scripts for untrusted packages, so the link step does not run otherwise.

## Start an S3-compatible backend

Atlas writes backups to any S3-compatible object store. For local development and testing, start MinIO with the included Docker Compose file:

```bash
cd docker && docker compose up -d
```

MinIO listens on port **9000** (S3 API) and port **9001** (web console). For production storage, see the [self-hosting guide](./self-hosting/).

## Configure credentials

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Required variables:

| Variable                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `ATLAS_TENANT_ID`             | Microsoft Entra tenant ID                      |
| `ATLAS_CLIENT_ID`             | App registration client ID                     |
| `ATLAS_CLIENT_SECRET`         | App registration client secret                 |
| `ATLAS_S3_ENDPOINT`           | S3 endpoint URL, for example `http://localhost:9000` |
| `ATLAS_S3_ACCESS_KEY`         | S3 access key                                  |
| `ATLAS_S3_SECRET_KEY`         | S3 secret key                                  |
| `ATLAS_ENCRYPTION_PASSPHRASE` | Master passphrase for envelope encryption      |

The first three values come from a Microsoft Entra app registration, described in [Microsoft Entra ID setup](./azure-ad-setup.md). For every other option, and for how `.env`, environment variables, and flags interact, see [Configuration](./configuration.md).

You can also store values in the CLI's encrypted local store with `atlas config set <key> <value>`, for example `atlas config set tenant.id <tenant-id>`. Run `atlas config list` to see the keys.

::: danger Protect your passphrase
The encryption passphrase cannot be recovered. Atlas has no reset mechanism and no recovery key. If the passphrase is lost, the backup data stays encrypted and cannot be read. Store it in a password manager or secrets vault, and confirm you can retrieve it before you rely on the backups. See [Security](./security.md) for the full encryption model.
:::

## Run your first backup

Back up one mailbox, one OneDrive, or one SharePoint site:

```bash
# Outlook mailbox
atlas outlook backup --mailbox user@company.com

# OneDrive for one user
atlas onedrive backup -o user@company.com

# SharePoint site
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
```

To find mailboxes to loop over in a scheduler, run `atlas outlook mailboxes`. It reads the list live from Microsoft Graph.

The first run is a full synchronization. Atlas downloads and encrypts every message, attachment, or file. Later runs use [delta sync](./operations/delta-sync.md) and transfer only what changed.

## Check and browse backups

```bash
# Check whether a mailbox backup is up to date (no backup runs)
atlas outlook status -m user@company.com

# List backed-up mailboxes, then the snapshots for one mailbox
atlas outlook list
atlas outlook list -m user@company.com

# List OneDrive and SharePoint snapshots
atlas onedrive list-snapshots -o user@company.com
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
```

## Restore

Restore writes data back to Microsoft 365. Test with a non-production target first, and check that the account has the Graph permissions for write access described in [Microsoft Entra ID setup](./azure-ad-setup.md).

```bash
# Restore the Inbox of a mailbox into a test mailbox
atlas outlook restore -m user@company.com -f Inbox -T test-user@company.com

# Save a mailbox as an EML zip archive instead of restoring it
atlas outlook save -m user@company.com --output backup.zip
```

Omit `-T` to restore into the source mailbox. For OneDrive and SharePoint restores, see the [OneDrive backup](./onedrive-backup.md) and [SharePoint backup](./sharepoint-backup.md) guides.

Every command and option is listed in the [CLI reference](./reference/cli.md).

## Use the SDK

To drive Atlas from your own application, such as a backup portal or a multi-tenant scheduler, install the SDK:

```bash
npm add @wisecom/atlas-sdk
```

The SDK exposes the same workloads as the CLI, grouped by namespace. It does not read `.env`. Pass configuration explicitly when you create the instance:

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: 'your-tenant-id',
  clientId: 'app-client-id',
  clientSecret: 'app-client-secret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  encryptionPassphrase: 'my-secret-passphrase',
});

// Outlook: same as `atlas outlook backup`
const mailbox = await atlas.outlook.backup('user@company.com');

// OneDrive: same as `atlas onedrive backup`
const drive = await atlas.onedrive.backup('owner-id');

// SharePoint: same as `atlas sharepoint backup`. Returns one result per backed-up site.
const [site] = await atlas.sharepoint.backup('site-id');
```

The SDK validates configuration when you call `createAtlasInstance`. A missing field or a passphrase shorter than the minimum throws a `ConfigError`.

::: tip Next steps
- [Concepts](./concepts.md): how snapshots, encryption, and storage layout fit together.
- [Configuration](./configuration.md): every option and environment variable.
- [SDK reference](./reference/sdk.md) and [SDK examples](./reference/examples.md): full method list and production patterns.
:::

## See also

- [Concepts](./concepts.md)
- [Security](./security.md)
- [Troubleshooting](./troubleshooting.md)
- [CLI reference](./reference/cli.md)
- [SDK reference](./reference/sdk.md)
