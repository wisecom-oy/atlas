# Getting Started

## Installation

Install Atlas globally from npm:

```bash
npm install -g m365-atlas
```

Requires **Node.js 20** or later.

## Start an S3-Compatible Backend

Atlas stores backups in any S3-compatible object storage. For local development or testing, start MinIO with the included Docker Compose file:

```bash
cd docker && docker compose up -d
```

This starts MinIO on port **9000** (S3 API) and port **9001** (web console). See the [Self-Hosting Guide](./self-hosting.md) for production deployment with external storage, RAID, and security hardening.

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

See [Configuration](./configuration.md) for all options and precedence rules.

::: danger Protect Your Passphrase
The encryption passphrase is **irrecoverable**. If you lose it, all backup data becomes permanently inaccessible. There is no reset mechanism, no recovery key, and no way to decrypt without it. Store it in a password manager or secrets vault, and test that you can retrieve it before relying on the backups. See [Security](./security.md) for the full encryption model.
:::

## First Backup

```bash
# back up a single mailbox
atlas outlook backup --mailbox user@company.com

# back up all licensed mailboxes in the tenant
atlas outlook backup
```

The first backup for a mailbox performs a full synchronization -- every message and attachment is downloaded and encrypted. Subsequent runs use [delta sync](./operations/delta-sync.md) to transfer only changes, which is dramatically faster.

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
```

See the full [CLI Reference](./reference/cli.md) for all commands and options.

## Use as a Library

Atlas also exposes a typed SDK for embedding in Node.js applications:

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({
  tenantId: 'your-azure-tenant-id',
  clientId: 'app-client-id',
  clientSecret: 'app-client-secret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  encryptionPassphrase: 'my-secret-passphrase',
});

const result = await atlas.outlook.backup('user@company.com');
```

See the [SDK Reference](./reference/sdk.md) for all available methods.
