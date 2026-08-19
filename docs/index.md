---
layout: home
hero:
  name: M365 Atlas
  text: Secure Microsoft 365 Backups
  tagline: Open-source CLI and SDK for encrypted, deduplicated backups of Outlook, OneDrive, and SharePoint to S3-compatible storage.
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
      link: https://github.com/wisecom-oy/atlas

features:
  - title: Per-Tenant Encryption
    details: Each tenant gets its own AES-256-GCM data key derived via scrypt. Data stays encrypted even if storage is breached.
  - title: Content-Addressed Deduplication
    details: Messages, attachments, and files are keyed by SHA-256 hash, so identical content is stored once across snapshots.
  - title: Storage-Level Immutability
    details: S3/MinIO Object Lock with time-based retention, enforced by storage itself rather than application metadata.
  - title: Delta Sync
    details: Microsoft Graph delta queries drive incremental backups, with automatic full-scan fallback after an interrupted run.
  - title: Multi-Workload Protection
    details: Outlook mailboxes, OneDrive files, and SharePoint document libraries in one tool under one encryption model.
  - title: Snapshot Replication
    details: Replicate encrypted snapshots to secondary S3 targets for disaster recovery across every workload.
  - title: CLI and SDK Packages
    details: '@wisecom/atlas-cli for shell deployment and cron jobs. @wisecom/atlas-sdk for embedding in Node.js apps through a typed, namespaced API.'
---
