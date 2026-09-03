# @wisecom/atlas-sdk

Programmatic API for embedding [Atlas](https://github.com/wisecom-oy/atlas) in Node.js applications. Atlas backs up and restores Microsoft 365 data.

Use this package for custom schedulers, multi-tenant SaaS, backup portals, and automation that needs typed control over Outlook, OneDrive, and SharePoint workloads. All internal modules are bundled; install this package alone with no peer `@wisecom/atlas-*` dependencies.

## Requirements

- Node.js 22.8 or later

## Install

```bash
npm add @wisecom/atlas-sdk
```

Beta releases use the `beta` dist-tag:

```bash
npm add @wisecom/atlas-sdk@beta
```

## Quick start

Config is explicit at construction time. The SDK does **not** read `.env` files or environment variables.

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

// Outlook backup
await atlas.outlook.backup('user@company.com');

// OneDrive backup
await atlas.onedrive.backup('user@company.com');

// SharePoint backup: pass a site URL or Graph site id, add subsites when needed
await atlas.sharepoint.backup('https://contoso.sharepoint.com/sites/Engineering', {
  includeSubsites: true,
});
```

## API overview

| Namespace / method          | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `atlas.outlook`             | Mailbox backup, restore, verify, catalog |
| `atlas.onedrive`            | OneDrive backup and verification         |
| `atlas.sharepoint`          | SharePoint site backup and restore       |
| `atlas.getBucketStats()`    | Storage statistics                       |
| `atlas.checkStorage()`      | S3 Object Lock readiness                 |
| `atlas.replicateSnapshot()` | Cross-region replication                 |
| `createStorageTarget()`     | Configure secondary S3 targets           |

The SDK re-exports domain types, port interfaces, and `GRAPH_SERVICE_LIMITS` from a single import.

## CLI alternative

For shell-based operations, cron jobs, and operator workflows, use [`@wisecom/atlas-cli`](https://www.npmjs.com/package/@wisecom/atlas-cli).

## Documentation

Full SDK reference, examples, and security model:

**https://wisecom-oy.github.io/atlas/reference/sdk**

## License

Code is licensed under Apache-2.0, Copyright 2026 [Wisecom Oy](https://wisecom.fi).

The Atlas and Wisecom names and logos are trademarks of Wisecom Oy and are not covered by that licence. See [`assets/LICENSE.md`](https://github.com/wisecom-oy/atlas/blob/main/assets/LICENSE.md) in the repository.
