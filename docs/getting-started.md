# Getting Started

Install the CLI, point it at storage and a tenant, run a backup. Node.js 22 or later is required.

## Installation

Atlas ships as two npm packages that share the same engine:

| Package                  | Command                             | Best for                                                                                 |
| ------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **`@wisecom/atlas-cli`** | `npm install -g @wisecom/atlas-cli` | Shell operations, cron/systemd jobs, operator workflows. Reads `.env` automatically.     |
| **`@wisecom/atlas-sdk`** | `npm add @wisecom/atlas-sdk`        | Node.js apps, custom schedulers, multi-tenant SaaS, portals. Explicit config, typed API. |

This guide uses the CLI. A local (non-global) install still gets an `atlas` command: a postinstall hook links it onto your PATH, skipping with a warning if the name is already an alias or another command. See the [CLI reference](/reference/cli) for details.

## Start an S3-Compatible Backend

Atlas stores backups in any S3-compatible object storage. For local development or testing, start MinIO with the included Docker Compose file:

```bash
cd docker && docker compose up -d
```

MinIO comes up on port **9000** (S3 API) and port **9001** (web console). For production storage, RAID, and security hardening, see the [Self-Hosting Guide](./self-hosting/).

## Configure

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:

| Variable                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `ATLAS_TENANT_ID`             | Azure AD tenant ID                             |
| `ATLAS_CLIENT_ID`             | App registration client ID                     |
| `ATLAS_CLIENT_SECRET`         | App registration client secret                 |
| `ATLAS_S3_ENDPOINT`           | S3 endpoint URL (e.g. `http://localhost:9000`) |
| `ATLAS_S3_ACCESS_KEY`         | S3 access key                                  |
| `ATLAS_S3_SECRET_KEY`         | S3 secret key                                  |
| `ATLAS_ENCRYPTION_PASSPHRASE` | Master passphrase for envelope encryption      |

The first three values come from an Entra app registration, covered in [Azure AD Setup](./azure-ad-setup.md). For every other option and the precedence rules between `.env`, environment variables, and flags, see [Configuration](./configuration.md).

::: danger Protect Your Passphrase
The encryption passphrase is **irrecoverable**. Lose it and all backup data becomes permanently inaccessible: no reset mechanism, no recovery key, no way to decrypt without it. Store it in a password manager or secrets vault and confirm you can retrieve it before you rely on the backups. [Security](./security.md) covers the full encryption model.
:::

## First Backup

**Outlook mailboxes:**

```bash
# back up a single mailbox
atlas outlook backup --mailbox user@company.com

# back up all licensed and shared mailboxes in the tenant
atlas outlook backup
```

**OneDrive files:**

```bash
atlas onedrive backup -o user@company.com
```

**SharePoint document libraries:**

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
```

The first run is a full synchronization: every message, attachment, or file is downloaded and encrypted. Later runs use [delta sync](./operations/delta-sync.md) to transfer only what changed, which is dramatically faster.

## Explore Your Backups

```bash
# check if a mailbox is up to date
atlas outlook status -m user@company.com

# list what was backed up
atlas outlook list

# restore a folder from backup
atlas outlook restore -m user@company.com -f Inbox

# save as EML zip archive
atlas outlook save -m user@company.com -o backup.zip

# list OneDrive snapshots
atlas onedrive list-snapshots -o user@company.com

# list SharePoint snapshots
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
```

Every command and option is listed in the [CLI Reference](./reference/cli.md). For workload-specific behavior, see the [OneDrive Backup](./onedrive-backup.md) and [SharePoint Backup](./sharepoint-backup.md) guides.

## Use as a Library

To drive Atlas from your own application, such as a backup portal, a multi-tenant scheduler, or a SaaS integration, install the SDK instead of (or alongside) the CLI:

```bash
npm add @wisecom/atlas-sdk
```

The SDK exposes the same workloads as the CLI, organized by namespace. Config is passed explicitly at construction time, since the SDK does not read `.env`:

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: 'your-azure-tenant-id',
  clientId: 'app-client-id',
  clientSecret: 'app-client-secret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  encryptionPassphrase: 'my-secret-passphrase',
});

// Outlook — mirrors `atlas outlook backup`
const result = await atlas.outlook.backup('user@company.com');

// OneDrive — mirrors `atlas onedrive backup`
const odResult = await atlas.onedrive.backup('owner-id');

// SharePoint — mirrors `atlas sharepoint backup`
const spResult = await atlas.sharepoint.backup('site-id');
```

See the [SDK Reference](./reference/sdk.md) for all methods and [SDK Examples](./reference/examples.md) for production-ready patterns.
