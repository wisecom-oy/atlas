# Roadmap

What Atlas has shipped, newest first, and what is planned next.

## Shipped

### v2.1.0-beta.1: Release automation _(current release)_

Releases are now cut and published by CI. A human still decides when and what size, and everything after that decision is automated. See [Release Process](/development/releases) for the full flow.

- **Start release workflow**: `release-start.yml` branches `release/v<version>` from `dev` (or `hotfix/v<version>` from `main`), bumps all nine workspace packages in lockstep, and commits through GitHub's `createCommitOnBranch` mutation so the commit is signed.
- **Tag on version bump**: `publish.yml` reads `packages/sdk/package.json` on every merge into `main` and tags `v<version>` only when that tag does not already exist. Non-release merges cost nothing, and a hotfix uses the same path as a release.
- **npm OIDC trusted publishing**: no `NPM_TOKEN` secret exists. Tagging and publishing stay in one workflow file because npm validates the entry-point workflow, so splitting them breaks authentication after the tag is already pushed.
- **Prerelease dist-tags**: the dist-tag is derived from the version suffix, so a prerelease can never become the default install. `2.1.0-beta.1` is published under `beta` and requires `@beta` to install.
- **Version guard**: a `release-guard` CI job fails release and hotfix PRs when the branch name disagrees with the package version, or when the tag already exists and merging would publish nothing.
- **Automatic dev sync**: `sync-dev` fast-forwards `dev` onto `main` after a release or hotfix, and fails loudly with a compare link if the branches have diverged.

### v2.1.0-beta: Live-tenant validation and reliability

Manual end-to-end testing was replaced with a nightly pipeline that drives the shipped CLI against a real Microsoft 365 tenant. This section also lists the bugs that pipeline found.

**End-to-end pipeline**

- **Full lifecycle per workload**: Outlook, OneDrive, and SharePoint each run seed, backup, verify, export, delete from M365, restore, then compare through Graph.
- **Disaster recovery drill**: replicate to a second endpoint, destroy the primary bucket, rehydrate, and verify that recovered data decrypts under the recovered key.
- **Immutability coverage**: Object Lock retention read back through the S3 API.
- **Regression guards**: one case per shipped bug that only reproduces against real infrastructure.
- **Nightly schedule with public-safe reporting**: a cron run at 03:00 UTC posts per-suite results in the run summary, with logs and artifacts scrubbed of tenant-identifying data.

**Fixes it surfaced, and hardening alongside**

- **SharePoint version backup**: a freshly uploaded file no longer fails its first backup. The current version is not fetched through the version-content endpoint, which Graph rejects.
- **Site identifiers**: `--site` accepts a browser URL, `hostname:/sites/name`, or a composite id everywhere, including `replicate` and `rehydrate`.
- **Read-only commands provision nothing**: `list`, `stats`, and `list-users` against an unknown tenant no longer create a bucket or bootstrap key material.
- **Honest error classification**: a storage authorization failure during restore is reported as a storage error, not as AES-GCM tampering.
- **Tenant-wide recovery**: `rehydrate --all` recovers every workload rather than Outlook alone, and OneDrive scope (`-o`) reaches `replicate` and `rehydrate`.
- **Graceful cancellation**: Outlook, OneDrive, and SharePoint honour interruption during finalization, and version download failures fail the run with a reason instead of passing silently.
- **Typecheck in CI**: the compiler is a merge gate, so a type error can no longer hide behind a warm build cache.

See [`e2e/README.md`](https://github.com/wisecom-oy/atlas/blob/main/e2e/README.md) for what a run does and how to add a case.

### v2.0.0: Multi-workload and monorepo

Atlas moved beyond Outlook mailboxes to additional Microsoft 365 workloads, and the codebase was restructured for independent package releases.

- **OneDrive backup**: incremental file backup via Graph delta queries, with zero-disk streaming for large files (64 MiB+), version history, and content-addressed deduplication under `onedrive/` storage prefixes.
- **SharePoint backup**: site-targeted document library backup with per-library delta cursors, zero-disk streaming, and version history under `sharepoint/` storage prefixes.
- **Namespaced CLI**: workload commands grouped under `atlas outlook`, `atlas onedrive`, and `atlas sharepoint`. Cross-cutting operations (`replicate`, `rehydrate`, `stats`, `storage-check`) remain at the root.
- **Monorepo restructure**: split into dedicated packages (`@wisecom/atlas-cli`, `@wisecom/atlas-sdk`, shared domain and ports) with independent versioning and smaller install footprints.
- **Multi-workload replication**: `atlas replicate` and `atlas rehydrate` extended with `--site` for SharePoint. OneDrive and Outlook snapshots replicate through the same tenant bucket and DEK.
- **Unified encryption model**: all workloads share the per-tenant DEK and scrypt-derived KEK. Storage layout is documented per workload in [Storage Layout](/operations/storage-layout).

### v1.3.0: Security hardening and restore reliability

A security audit and restore-flow hardening pass driven by external review findings.

- **Versioned DEK blob format**: `v1` header with KDF ID, params, and salt, so the algorithm can be upgraded later.
- **Random salt per DEK**: each `wrap_dek` generates a fresh 32-byte salt instead of reusing a fixed derivation.
- **Blob header in GCM AAD**: version, KDF ID, KDF params, and salt are authenticated as additional data, preventing header tampering.
- **Minimum scrypt work factor**: `N >= 16384` is enforced to block trivially weak KDF parameters.
- **Secure passphrase handling**: the master passphrase is stored as a zeroable `Buffer` with a `TenantContext.destroy()` lifecycle.
- **Tenant ID in KEK derivation**: domain separation was re-introduced, so cross-tenant DEK decryption is impossible even with the same passphrase.
- **Post-restore verification**: folder message-count verification with structured results that distinguish API failures from genuine discrepancies.
- **Restore error reporting**: separate `errors`, `attachment_errors`, and `verification_warnings` arrays with consistent counts.
- **Deletion safety**: `delete_snapshot` uses a storage-only context to avoid auto-generating a DEK when `_meta/dek.enc` is missing.
- **Replication integrity**: partial replications no longer write manifests, and each manifest DEK is validated inside the rehydration loop.
- **Graph API request timeout**: a 60-second `race_timeout` wrapper prevents indefinite hangs from silent throttling.
- **Restore-integrity verification**: post-restore folder verification integrated into the restore pipeline.
- **Dependency security patches**: Dependabot vulnerability fixes.

### v1.2.3: Replication and documentation

Added disaster recovery and the documentation site.

- **Snapshot replication**: `atlas replicate` copies encrypted snapshots between S3 targets for disaster recovery.
- **Rehydration**: `atlas rehydrate` restores snapshots from a replica back to the primary.
- **Replication status tracking**: per-snapshot status records (COMPLETED, PARTIAL, FAILED).
- **VitePress documentation site**: self-hosting guide, security model, operations guides, and SDK examples.
- **Security fix**: the regex-based HTML stripper was replaced with the parser-based `html-to-text` to prevent ReDoS.

### v1.2.0: Operations and observability

Operational tooling for multi-mailbox environments.

- **`atlas stats` command**: bucket-wide and per-mailbox statistics (object counts, sizes, folder breakdowns, monthly trends).
- **`atlas status` command**: delta-based freshness check that reports pending changes per folder without running a full backup.
- **Inline image handling**: correct backup and restore of CID-referenced inline images.
- **Rate-aware backup**: integrated rate limiter and throttle fence for Graph API compliance.
- **Progress adapter**: dedicated backup progress tracking with per-folder dashboards.
- **Improved deletion**: safer deletion order and separate mailbox, snapshot, and purge paths.
- **Memory-safe save**: streaming archive creation with finalized state management.

### v1.1.0: SDK, save, and verification

Broadened the interface surface and added data export.

- **Type-safe SDK**: programmatic `Atlas` class for embedding backup, restore, save, and verification in custom tooling.
- **`atlas save` command**: export snapshots or entire mailboxes to local `.zip` archives, with optional integrity checks.
- **`atlas verify` command**: download, decrypt, and SHA-256-verify every object in a snapshot against its manifest checksum, using constant-time comparison.
- **Object Lock and immutability**: S3 Object Lock policy support with governance and compliance modes.
- **Mailbox existence checks**: fail fast when a mailbox ID is invalid or unlicensed.
- **Graph API retry hardening**: exponential backoff with network and retryable error detection, up to 12 attempts.
- **npm publish pipeline**: automated CI/CD for npm releases.

### v1.0.0: Foundation

The initial release established the core backup and restore pipeline for Microsoft 365 mailboxes.

- **Backup engine**: full and incremental mailbox backup via Microsoft Graph delta queries.
- **Restore engine**: restore messages with attachments back to the original or a different mailbox.
- **Envelope encryption**: AES-256-GCM with a scrypt-derived KEK and a per-tenant DEK.
- **S3-compatible storage**: MinIO, AWS S3, or any S3-compatible backend.
- **Attachment support**: backup and restore of file and inline image attachments.
- **Graceful interruption**: `SIGINT` handling with progress saving, so interrupted backups resume cleanly.
- **Hexagonal architecture**: ports and adapters with Inversify DI for testability.

## Upcoming

### Microsoft Teams backup

Extend Atlas to Teams as a first-class workload. Team files already ride along with SharePoint backup, since every team is backed by a site, so the gap is conversational and structural data: channel messages with replies and reactions, membership and ownership, and channel and tab configuration.

The design constraint is Graph, not Atlas. Teams messages have no delta query comparable to `/messages/delta`, and bulk export runs through the protected `getAllMessages` endpoints, which require Microsoft approval per application and are metered per message retrieved. So this workload has to be planned around a request budget that has a real invoice attached, with change notifications as the incremental mechanism instead of a delta cursor. Chats (`/chats/{id}/messages`) are a separate scope decision from channels. They are personal data with different retention expectations, and will be opt-in rather than implied by a tenant backup.

### Microsoft Entra ID backup

Back up directory configuration, which is the part of a tenant that no mailbox restore can rebuild: users and their attributes, groups and memberships, directory roles and administrative units, app registrations and service principals, Conditional Access policies, and named locations.

Two properties make this different from data backup and shape the design:

- **Restore is reapplication, not byte recovery.** Recreating a Conditional Access policy or an app registration produces new object IDs, and client secrets are write-only in Graph. They cannot be read back at any privilege level. So the deliverable is a versioned configuration export plus a reviewed, diff-driven reapply path, never a silent overwrite of a live directory.
- **The native window is short.** Deleted users, groups, and applications sit in `/directory/deletedItems` for 30 days, and Conditional Access policy changes have no native history at all. The value Atlas adds is longer retention and a point-in-time diff that answers "what changed in this tenant, and when".

Throttling is already modelled for this pool (`IdentityServiceLimits`: resource units on a token bucket, per app per tenant plus a global ceiling), so the cost accounting this needs is in place before the workload is.

### Argon2 KDF migration

Evaluate replacing scrypt with Argon2id for KEK derivation. The versioned DEK blob format (`v1`) already includes a `kdf_id` field, making algorithm upgrades possible without breaking existing tenants. This includes building an `atlas migrate-kdf` command that re-wraps all DEK blobs under the new KDF without re-encrypting data objects.

### Graph throttling and cost audit

Profiling and optimization are done. `tools/perf` measures the pipelines, and per-request cost is attributed per service pool (`getGraphCost`). What remains is auditing measured behaviour against the limits Atlas already models in `GRAPH_SERVICE_LIMITS`, because each pool fails differently: Outlook counts requests flatly per app per mailbox, SharePoint and OneDrive spend resource units that scale with tenant license count, and the identity pool refills on a token bucket.

The audit uses `tools/graph-tap` traces from real runs to answer concrete questions. How close does a large-tenant backup come to the per-window ceiling? Which call patterns spend resource units disproportionately? Does concurrency tuned for throughput on a small tenant push a large one into sustained 429s? The outcome is measured headroom per pool and concurrency defaults chosen against it, not a faster benchmark on one tenant.
