![GitHub Repo Banner](https://ghrb.waren.build/banner?header=M365+Atlas&subheader=%F0%9F%94%90+Secure%2C+deduplicated+Microsoft+365+mailbox+backups.&bg=EC4899-3B82F6&color=FFFFFF&headerfont=Google+Sans&subheaderfont=Kinewave&watermarkpos=bottom-right)

<!-- Created with GitHub Repo Banner by Waren Gonzaga: https://ghrb.waren.build -->

[![CI](https://github.com/miikaok/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/miikaok/atlas/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/miikaok/34b7e6013b428e289db442d3d28f4f14/raw/m365-atlas-coverage.json)](https://github.com/miikaok/atlas/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@atlas/cli)](https://www.npmjs.com/package/@atlas/cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Socket Badge](https://badge.socket.dev/npm/package/@atlas/cli)](https://socket.dev/npm/package/@atlas/cli)

An open-source CLI backup and restore engine for Microsoft 365. Protects Outlook mailboxes, OneDrive files, and SharePoint document libraries with per-tenant envelope encryption, content-addressed deduplication, multi-layer integrity validation, and efficient delta synchronization against S3-compatible object storage.

## Highlights

- **Per-tenant encryption** — AES-256-GCM with scrypt-derived keys
- **Content-addressed deduplication** — messages, attachments, and files stored once by SHA-256 hash
- **Multi-workload protection** — Outlook mailboxes, OneDrive, and SharePoint document libraries
- **Storage-level immutability** — S3/MinIO Object Lock with time-based retention
- **Delta sync** — incremental backups via Microsoft Graph delta queries
- **Snapshot replication** — replicate encrypted snapshots to secondary S3 targets for DR
- **Typed SDK** — embed in Node.js apps via `@atlas/sdk`
- **Live dashboard** — real-time ANSI progress for single and tenant-wide backups

## Quick Start

```bash
npm install -g @atlas/cli

# Outlook
atlas outlook backup --mailbox user@company.com   # single mailbox
atlas outlook backup                               # all tenant mailboxes
atlas outlook status -m user@company.com           # check freshness

# OneDrive
atlas onedrive backup -o user@company.com

# SharePoint
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
```

See [Getting Started](https://miikaok.github.io/atlas/getting-started) for full setup instructions.

## Documentation

| Topic              | Link                                                          |
| ------------------ | ------------------------------------------------------------- |
| Getting Started    | [docs](https://miikaok.github.io/atlas/getting-started)      |
| Self-Hosting       | [docs](https://miikaok.github.io/atlas/self-hosting)         |
| Configuration      | [docs](https://miikaok.github.io/atlas/configuration)        |
| Azure AD Setup     | [docs](https://miikaok.github.io/atlas/azure-ad-setup)       |
| OneDrive Backup    | [docs](https://miikaok.github.io/atlas/onedrive-backup)      |
| SharePoint Backup  | [docs](https://miikaok.github.io/atlas/sharepoint-backup)    |
| Security Model     | [docs](https://miikaok.github.io/atlas/security)             |
| CLI Reference      | [docs](https://miikaok.github.io/atlas/reference/cli)        |
| SDK Reference      | [docs](https://miikaok.github.io/atlas/reference/sdk)        |

## Development

```bash
pnpm install
pnpm run build          # bundle with tsdown
pnpm run test           # vitest (unit tests)
pnpm run test:coverage  # with v8 coverage
pnpm run lint           # eslint
pnpm run format         # prettier
pnpm run docs:dev       # local docs site
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions, code conventions, architecture overview, and pull request guidelines.

## License

Copyright 2026 Miika Oja-Kaukola

This project is licensed under the Apache License, Version 2.0.  
See the [LICENSE](./LICENSE) file for details.
