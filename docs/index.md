---
layout: home
hero:
  name: M365 Atlas
  text: Secure Microsoft 365 Backups
  tagline: Open-source CLI and SDK for encrypted, deduplicated backups of Outlook mailboxes, OneDrive, and SharePoint to S3-compatible storage.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: CLI Reference
      link: /reference/cli
    - theme: alt
      text: SDK Reference
      link: /reference/sdk
    - theme: alt
      text: View on GitHub
      link: https://github.com/miikaok/atlas

features:
  - title: Per-Tenant Encryption
    details: Each tenant gets a unique AES-256-GCM key derived via scrypt. Data stays encrypted even if storage is breached.
  - title: Content-Addressed Deduplication
    details: Messages, attachments, and files are stored by SHA-256 hash. Identical content is stored once across snapshots.
  - title: Storage-Level Immutability
    details: S3/MinIO Object Lock with time-based retention enforced by storage itself, not app metadata.
  - title: Delta Sync
    details: Microsoft Graph delta queries for incremental backups with automatic full-scan fallback on interrupted runs.
  - title: Multi-Workload Protection
    details: Back up Outlook mailboxes, OneDrive files, and SharePoint document libraries with a single tool and unified encryption.
  - title: Snapshot Replication
    details: Replicate encrypted snapshots to secondary S3 targets for disaster recovery across all workloads.
  - title: CLI & SDK Packages
    details: "@wisecom/atlas-cli for shell deployment and cron jobs; @wisecom/atlas-sdk for embedding in Node.js apps with a typed, namespaced API."
  - title: Typed SDK
    details: Programmatic API for embedding in other Node.js applications via the standalone @wisecom/atlas-sdk package.
---
