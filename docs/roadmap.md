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

### v2.0.0 — Multi-Workload & Monorepo

Extended Atlas beyond Outlook mailboxes to additional Microsoft 365 workloads and restructured the codebase for independent package releases.

- **OneDrive backup** — incremental file backup via Graph delta queries with zero-disk streaming for large files (512 MiB+), version history, and content-addressed deduplication under `onedrive/` storage prefixes
- **SharePoint backup** — site-targeted document library backup with per-library delta cursors, zero-disk streaming, and version history under `sharepoint/` storage prefixes
- **Namespaced CLI** — workload commands grouped under `atlas outlook`, `atlas onedrive`, and `atlas sharepoint`; cross-cutting operations (`replicate`, `rehydrate`, `stats`, `storage-check`) remain at the root
- **Monorepo restructure** — split into dedicated packages (`@wisecom/atlas-cli`, `@wisecom/atlas-sdk`, shared domain/ports) with independent versioning and smaller install footprints
- **Multi-workload replication** — `atlas replicate` and `atlas rehydrate` extended with `--site` for SharePoint; OneDrive and Outlook snapshots replicate through the same tenant bucket and DEK
- **Unified encryption model** — all workloads share the per-tenant DEK and scrypt-derived KEK; storage layout documented per workload in [Storage Layout](/operations/storage-layout)

### v2.1.0-beta — Live-Tenant Validation & Reliability _(current release)_

Replaced manual end-to-end testing with a nightly pipeline that drives the shipped CLI against a real Microsoft 365 tenant — and fixed everything it found.

**End-to-end pipeline**

- **Full lifecycle per workload** — Outlook, OneDrive, and SharePoint each run seed → backup → verify → export → delete from M365 → restore → compare through Graph
- **Disaster recovery drill** — replicate to a second endpoint, destroy the primary bucket, rehydrate, and verify that recovered data decrypts under the recovered key
- **Immutability coverage** — Object Lock retention read back through the S3 API
- **Regression guards** — one case per shipped bug that only reproduces against real infrastructure
- **Nightly schedule, public-safe reporting** — per-suite results in the run summary; logs and artifacts scrubbed of tenant-identifying data

**Fixes it surfaced, and hardening alongside**

- **SharePoint version backup** — a freshly uploaded file no longer fails its first backup; the current version is not fetched through the version-content endpoint, which Graph rejects
- **Site identifiers** — `--site` accepts a browser URL, `hostname:/sites/name`, or a composite id everywhere, including `replicate` and `rehydrate`
- **Read-only commands provision nothing** — `list`, `stats`, and `list-users` against an unknown tenant no longer create a bucket or bootstrap key material
- **Honest error classification** — a storage authorization failure during restore is reported as a storage error, not as AES-GCM tampering
- **Tenant-wide recovery** — `rehydrate --all` recovers every workload rather than Outlook alone, and OneDrive scope (`-o`) reaches `replicate`/`rehydrate`
- **Graceful cancellation** — Outlook, OneDrive, and SharePoint honour interruption during finalization, and version download failures fail the run with a reason instead of passing silently
- **Typecheck in CI** — the compiler is a merge gate, so a type error can no longer hide behind a warm build cache

See [`e2e/README.md`](https://github.com/wisecom-oy/atlas/blob/main/e2e/README.md) for what a run does and how to add a case.

---

## Upcoming

### Microsoft Teams Backup

Extend Atlas to Teams as a first-class workload. Team files already ride along with SharePoint backup -- every team is backed by a site -- so the gap is conversational and structural data: channel messages with replies and reactions, membership and ownership, and channel/tab configuration.

The design constraint is Graph, not Atlas. Teams messages have no delta query comparable to `/messages/delta`, and bulk export runs through the protected `getAllMessages` endpoints, which require Microsoft approval per application and are metered per message retrieved. So this workload has to be planned around a request budget that has a real invoice attached, with change notifications as the incremental mechanism instead of a delta cursor. Chats (`/chats/{id}/messages`) are a separate scope decision from channels: they are personal data with different retention expectations, and will be opt-in rather than implied by a tenant backup.

### Microsoft Entra ID Backup

Back up directory configuration, which is the part of a tenant that no mailbox restore can rebuild: users and their attributes, groups and memberships, directory roles and administrative units, app registrations and service principals, Conditional Access policies, and named locations.

Two properties make this different from data backup and shape the design:

- **Restore is reapplication, not byte recovery.** Recreating a Conditional Access policy or an app registration produces new object IDs, and client secrets are write-only in Graph -- they cannot be read back at any privilege level. So the deliverable is a versioned configuration export plus a reviewed, diff-driven reapply path, never a silent overwrite of a live directory.
- **The native window is short.** Deleted users, groups, and applications sit in `/directory/deletedItems` for 30 days; Conditional Access policy changes have no native history at all. The value Atlas adds is longer retention and a point-in-time diff that answers "what changed in this tenant, and when".

Throttling is already modelled for this pool (`IdentityServiceLimits`: resource units on a token bucket, per app per tenant plus a global ceiling), so the cost accounting this needs is in place before the workload is.

### Argon2 KDF Migration

Evaluate replacing scrypt with Argon2id for KEK derivation. The versioned DEK blob format (`v1`) already includes a `kdf_id` field, making algorithm upgrades possible without breaking existing tenants. This includes building an `atlas migrate-kdf` command that re-wraps all DEK blobs under the new KDF without re-encrypting data objects.

### Graph Throttling & Cost Audit

Profiling and optimization are done -- `tools/perf` measures the pipelines, and per-request cost is attributed per service pool (`getGraphCost`). What remains is auditing measured behaviour against the limits Atlas already models in `GRAPH_SERVICE_LIMITS`, because each pool fails differently: Outlook counts requests flatly per app per mailbox, SharePoint/OneDrive spends resource units that scale with tenant license count, and the identity pool refills on a token bucket.

The audit uses `tools/graph-tap` traces from real runs to answer concrete questions: how close does a large-tenant backup come to the per-window ceiling, which call patterns spend resource units disproportionately, and does concurrency tuned for throughput on a small tenant push a large one into sustained 429s. Outcome is measured headroom per pool and concurrency defaults chosen against it -- not a faster benchmark on one tenant.
