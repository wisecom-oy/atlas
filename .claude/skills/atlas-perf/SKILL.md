---
name: atlas-perf
description: >-
  Profile Atlas backup/restore pipelines and analyze CPU bottlenecks. Use when
  investigating performance issues, optimizing hot paths, or validating that
  changes to S3, Graph API, or encryption code don't introduce regressions.
when_to_use: >-
  The user asks to profile, benchmark, or optimize backup/restore performance;
  a change touches S3 uploads, Graph API fetching, encryption, or concurrency
  logic; the user shares a .cpuprofile file or profiling output to analyze.
---

# Atlas Performance Profiling

## When to Profile

Profile before and after any change to these critical paths, and include the delta in the PR description:

- **S3 storage layer** (`packages/s3/`): upload concurrency, encryption pipeline, object operations
- **Graph API layer** (`packages/m365-graph/`, `packages/*/src/adapters/`): page fetch parallelism, rate limiting, retry logic
- **Encryption** (`packages/core/src/adapters/keystore/`): key derivation, AES-GCM throughput, DEK operations
- **Backup orchestration** (`packages/outlook/src/services/backup/`, and `packages/{onedrive,sharepoint}/src/services/*-backup*.ts`): folder/drive/library sync, attachment handling, manifest building
- **Restore orchestration** (`packages/outlook/src/services/restore/`, and `packages/{onedrive,sharepoint}/src/services/*-restore*.ts`): message and file reconstruction, batch processing
- Any change to concurrency or parallelism settings

## Quick Reference

```bash
pnpm run perf:build                                        # build the profiler (once, and after any tools/perf/ change)
pnpm run perf:backup -- -m user@example.com                # profile a backup
pnpm run perf:restore -- -s <snapshot-id> -m target@example.com   # profile a restore
pnpm run perf:analyze -- .perf-output/CPU.*.cpuprofile     # analyze an existing profile (default output dir)
node tools/perf/dist/cli.js profile --flamegraph -- backup -m user@example.com   # flamegraph HTML (requires 0x)
```

## Interpreting the Output

The text report has four sections.

### 1. TOP FUNCTIONS BY SELF-TIME

Self-time = CPU spent **in this function only** (not its callees). High self-time means the function itself is expensive.

**Action**: inspect the implementation for synchronous crypto that could move to worker threads, unnecessary JSON serialization, tight loops, or repeated allocations.

### 2. DOMAIN BREAKDOWN

Aggregated by Atlas package. Tells you **which subsystem** dominates CPU.

| Domain                       | Meaning                                             |
| ---------------------------- | --------------------------------------------------- |
| `@wisecom/atlas-core/crypto` | Key derivation (scrypt), AES-GCM encrypt/decrypt    |
| `@wisecom/atlas-s3`          | S3 PutObject/GetObject, MD5 computation, TLS        |
| `@wisecom/atlas-m365-graph`  | Graph client, rate limiting, retry wrappers         |
| `@wisecom/atlas-*/backup`    | Folder/drive sync, attachment fetch, manifest build |
| `@wisecom/atlas-*/restore`   | Message reconstruction, folder creation             |
| `node:crypto`                | Node.js native crypto primitives                    |
| `node:network`               | TLS handshakes, TCP, HTTP/2 framing                 |
| `aws-sdk`                    | AWS SDK v3 internals                                |

### 3. HOT PATHS

The critical call chain from entry point to the most expensive leaf. Read top-to-bottom as a stack trace.

**Action**: look for unexpected depth (too many intermediaries) or surprising leaves (e.g. `JSON.parse` in a hot path means serialization overhead).

### 4. OBSERVATIONS

Auto-generated summary with percentages. Use as a starting point for investigation.

## Important Limitations

- **CPU profiles do NOT capture I/O wait.** Slow Graph API calls appear as idle and are invisible in the profile. The profile only shows compute.
- **For I/O analysis**, use the existing `elapsed_ms` timers in backup/restore output, or add wall-clock spans around suspected network calls.
- **Single-message profiles are not representative.** Profile with realistic data (50+ messages, attachments) to observe concurrency patterns.

## Workflow: Before/After Comparison

1. **Baseline**: run a profiled backup/restore BEFORE the change
2. **Save the report** (copy from stdout or keep the `.cpuprofile`)
3. **Implement the optimization**
4. **Re-profile**: run the same profiled command AFTER
5. **Compare**: focus on domain breakdown percentages and top functions

Paste both reports into the conversation for diff analysis, and include the delta in the PR description.

## Key Files

| Path                                  | Purpose                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `tools/perf/src/cli.ts`               | Entry point (`atlas-perf profile` / `atlas-perf analyze`) |
| `tools/perf/src/profiler.ts`          | Spawns node with `--cpu-prof`, manages output             |
| `tools/perf/src/profile-parser.ts`    | Reads `.cpuprofile`, builds call tree, computes times     |
| `tools/perf/src/domain-classifier.ts` | Maps V8 script URLs to Atlas domain names                 |
| `tools/perf/src/report-formatter.ts`  | Formats the analysis into structured text                 |
| `tools/perf/src/types.ts`             | TypeScript interfaces for profile data                    |

## Common Bottleneck Patterns

### Encryption too slow

- **Symptom**: `node:crypto` + `@wisecom/atlas-core/crypto` > 30% self-time
- **Root cause**: scrypt key derivation runs per-message instead of once per session
- **Fix**: cache the derived KEK for the session lifetime (already done via `TenantContext`)

### S3 uploads blocking

- **Symptom**: `@wisecom/atlas-s3` high self-time, especially MD5/checksum computation
- **Root cause**: ContentMD5 computed synchronously for each object
- **Fix**: stream-based checksums or worker thread offload

### Graph API client overhead

- **Symptom**: `@wisecom/atlas-m365-graph` or `ms-graph-sdk` high self-time
- **Root cause**: response parsing, token refresh serialization
- **Fix**: check whether JSON parsing of large responses dominates; consider streaming

### Too many intermediate layers

- **Symptom**: hot paths show 10+ frames of pass-through functions with zero self-time
- **Root cause**: over-abstraction adding call overhead
- **Fix**: inline hot-path intermediaries or reduce adapter layering
