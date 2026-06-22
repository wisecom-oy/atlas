# Roadmap

This page tracks delivered milestones and planned work for Atlas. Each version section summarizes the capabilities introduced in that release branch.

## Delivered

### v1.0.0 — Foundation

The initial release established the core backup and restore pipeline for Microsoft 365 mailboxes.

- **Backup engine** — full and incremental mailbox backup via Microsoft Graph delta queries
- **Restore engine** — restore messages (with attachments) back to the original or a different mailbox
- **Envelope encryption** — AES-256-GCM with scrypt-derived KEK and per-tenant DEK
- **S3-compatible storage** — MinIO, AWS S3, or any S3-compatible backend
- **Attachment support** — backup and restore of file and inline image attachments
- **Graceful interruption** — `SIGINT` handling with progress-saving so interrupted backups resume cleanly
- **Hexagonal architecture** — ports/adapters with Inversify DI for testability

### v1.1.0 — SDK, Save & Verification

Broadened the interface surface and added data export capabilities.

- **Type-safe SDK** — programmatic `Atlas` class for embedding backup, restore, save, and verification in custom tooling
- **`atlas save` command** — export snapshots or entire mailboxes to local `.zip` archives with optional integrity checks
- **`atlas verify` command** — download, decrypt, and SHA-256-verify every object in a snapshot against its manifest checksum (constant-time comparison)
- **Object Lock / Immutability** — S3 Object Lock policy support with governance and compliance modes
- **Mailbox existence checks** — fail fast when a mailbox ID is invalid or unlicensed
- **Graph API retry hardening** — exponential backoff with network and retryable error detection (up to 12 attempts)
- **npm publish pipeline** — automated CI/CD for npm releases

### v1.2.0 — Operations & Observability

Focused on operational tooling for multi-mailbox environments.

- **`atlas stats` command** — bucket-wide and per-mailbox statistics (object counts, sizes, folder breakdowns, monthly trends)
- **`atlas status` command** — delta-based freshness check that reports pending changes per folder without running a full backup
- **Inline image handling** — correct backup/restore of CID-referenced inline images
- **Rate-aware backup** — integrated rate limiter and throttle fence for Graph API compliance
- **Progress adapter** — dedicated backup progress tracking with per-folder dashboards
- **Improved deletion** — safer deletion order and separate mailbox/snapshot/purge paths
- **Memory-safe save** — streaming archive creation with finalized state management

### v1.2.3 — Replication & Documentation

Added disaster recovery and the documentation site.

- **Snapshot replication** — `atlas replicate` copies encrypted snapshots between S3 targets for disaster recovery
- **Rehydration** — `atlas rehydrate` restores snapshots from a replica back to the primary
- **Replication status tracking** — per-snapshot status records (COMPLETED / PARTIAL / FAILED)
- **VitePress documentation site** — full docs with self-hosting guide, security model, operations guides, and SDK examples
- **Security fix** — replaced regex-based HTML stripper with parser-based `html-to-text` to prevent ReDoS

### v1.3.0 — Security Hardening & Restore Reliability

Comprehensive security audit and restore-flow hardening driven by external review findings.

- **Versioned DEK blob format** — `v1` header with KDF ID, params, and salt for future algorithm upgrades
- **Random salt per DEK** — each `wrap_dek` generates a fresh 32-byte salt instead of reusing a fixed derivation
- **Blob header in GCM AAD** — version, KDF ID, KDF params, and salt are authenticated as additional data, preventing header tampering
- **Minimum scrypt work factor** — enforced `N >= 16384` to block trivially weak KDF parameters
- **Secure passphrase handling** — master passphrase stored as a zeroable `Buffer` with `TenantContext.destroy()` lifecycle
- **Tenant ID in KEK derivation** — re-introduced domain separation so cross-tenant DEK decryption is impossible even with the same passphrase
- **Post-restore verification** — folder message-count verification with structured results distinguishing API failures from genuine discrepancies
- **Restore error reporting** — separate `errors`, `attachment_errors`, and `verification_warnings` arrays with consistent counts
- **Deletion safety** — `delete_snapshot` uses storage-only context to avoid auto-generating a DEK when `_meta/dek.enc` is missing
- **Replication integrity** — partial replications no longer write manifests; per-manifest DEK validation inside the rehydration loop
- **Graph API request timeout** — 60-second `race_timeout` wrapper prevents indefinite hangs from silent throttling
- **Restore-integrity verification** — post-restore folder verification integrated into the restore pipeline
- **Dependency security patches** — Dependabot vulnerability fixes

### v2.0.0 — Multi-Workload & Monorepo *(current branch)*

Extended Atlas beyond Outlook mailboxes to additional Microsoft 365 workloads and restructured the codebase for independent package releases.

- **OneDrive backup** — incremental file backup via Graph delta queries with zero-disk streaming for large files (512 MiB+), version history, and content-addressed deduplication under `onedrive/` storage prefixes
- **SharePoint backup** — site-targeted document library backup with per-library delta cursors, zero-disk streaming, and version history under `sharepoint/` storage prefixes
- **Namespaced CLI** — workload commands grouped under `atlas outlook`, `atlas onedrive`, and `atlas sharepoint`; cross-cutting operations (`replicate`, `rehydrate`, `stats`, `storage-check`) remain at the root
- **Monorepo restructure** — split into dedicated packages (`@wisecom/atlas-cli`, `@wisecom/atlas-sdk`, shared domain/ports) with independent versioning and smaller install footprints
- **Multi-workload replication** — `atlas replicate` and `atlas rehydrate` extended with `--site` for SharePoint; OneDrive and Outlook snapshots replicate through the same tenant bucket and DEK
- **Unified encryption model** — all workloads share the per-tenant DEK and scrypt-derived KEK; storage layout documented per workload in [Storage Layout](/operations/storage-layout)

---

## Upcoming

### Code Quality & Refactoring

Systematic code quality pass across the entire codebase. Static analysis, complexity reduction, and enforcing consistent patterns in areas that grew organically during early development.

### Argon2 KDF Migration

Evaluate replacing scrypt with Argon2id for KEK derivation. The versioned DEK blob format (`v1`) already includes a `kdf_id` field, making algorithm upgrades possible without breaking existing tenants. This includes building an `atlas migrate-kdf` command that re-wraps all DEK blobs under the new KDF without re-encrypting data objects.

### Performance Profiling & Optimization

Instrument the backup and restore pipelines with flamechart analysis to identify bottlenecks. Candidates include S3 upload concurrency, Graph API page fetch parallelism, and encryption throughput. Targeted optimizations based on measured data rather than assumptions.

### CI/CD Restore & Backup Validation

Add automated end-to-end pipeline stages that run a full backup → verify → restore → compare cycle against a dedicated testing tenant on every merge request. This replaces manual E2E testing and catches regressions before they reach a release branch.

### SDK Documentation & Hosted Docs

Write comprehensive SDK documentation with API reference, integration guides, and production deployment patterns. Host the VitePress documentation site on a dedicated server with versioned docs per release branch, replacing the current local-only build.

### OneDrive & SharePoint Restore Enhancements

Expand restore capabilities for file workloads: cross-owner OneDrive restore, selective file filtering at scale, and SharePoint library-level restore with conflict resolution policies.
