---
name: atlas-perf
description: >-
  Profile Atlas backup/restore pipelines and analyze CPU bottlenecks. Use when
  investigating performance issues, optimizing hot paths, or validating that
  changes to S3, Graph API, or encryption code don't introduce regressions.
---

# Atlas Performance Profiling

Use this skill when:
- The user asks to profile, benchmark, or optimize backup/restore performance
- You need to identify CPU bottlenecks in the pipeline
- A change touches S3 uploads, Graph API fetching, encryption, or concurrency logic
- The user shares a `.cpuprofile` file or profiling output for analysis

## Quick Reference

### Build the profiler (required once)

```bash
pnpm run perf:build
```

### Profile a backup

```bash
pnpm run perf:backup -- -m user@example.com
```

### Profile a restore

```bash
pnpm run perf:restore -- -s <snapshot-id> -m target@example.com
```

### Analyze an existing profile

```bash
pnpm run perf:analyze -- <path-to-file>.cpuprofile
```

### With flamegraph HTML (optional, requires 0x)

```bash
node tools/perf/dist/cli.js profile --flamegraph -- backup -m user@example.com
```

## Interpreting the Output

The text report has four sections. Here is how to use each:

### 1. TOP FUNCTIONS BY SELF-TIME

Self-time = CPU spent **in this function only** (not its callees). High self-time means the function itself is expensive.

**Action**: If a function has disproportionate self-time, inspect its implementation for:
- Synchronous crypto operations that could use worker threads
- Unnecessary JSON serialization/parsing
- Tight loops or repeated allocations

### 2. DOMAIN BREAKDOWN

Aggregated by Atlas package. Tells you **which subsystem** dominates CPU.

| Domain | Meaning |
|--------|---------|
| `@wisecom/atlas-core/crypto` | Key derivation (scrypt), AES-GCM encrypt/decrypt |
| `@wisecom/atlas-s3` | S3 PutObject/GetObject, MD5 computation, TLS |
| `@wisecom/atlas-m365-graph` | Graph client, rate limiting, retry wrappers |
| `@wisecom/atlas-outlook/backup` | Folder sync, attachment fetch, manifest building |
| `@wisecom/atlas-outlook/restore` | Message reconstruction, folder creation |
| `node:crypto` | Node.js native crypto primitives |
| `node:network` | TLS handshakes, TCP, HTTP/2 framing |
| `aws-sdk` | AWS SDK v3 internals |

### 3. HOT PATHS

The critical call chain from entry point to the most expensive leaf. Read top-to-bottom as a stack trace.

**Action**: Look for unexpected depth (too many intermediaries) or surprising leaves (e.g., JSON.parse in a hot path means serialization overhead).

### 4. OBSERVATIONS

Auto-generated summary with percentages. Use as a starting point for investigation.

## Important Limitations

- **CPU profiles do NOT capture I/O wait**. If Graph API calls are slow due to network latency, that time appears as idle (invisible in the profile). The profile only shows compute.
- **For I/O analysis**, use the existing `elapsed_ms` timers in backup/restore output, or add wall-clock spans around suspected network calls.
- **Single-message profiles are not representative**. Profile with realistic data (50+ messages, attachments) to observe concurrency patterns.

## Workflow: Before/After Comparison

When optimizing, follow this pattern:

1. **Baseline**: Run a profiled backup/restore BEFORE your change
2. **Save the report** (copy from stdout or save the `.cpuprofile`)
3. **Implement your optimization**
4. **Re-profile**: Run the same profiled backup/restore AFTER
5. **Compare**: Focus on the domain breakdown percentages and top functions

Paste both reports into the conversation for diff analysis.

## Key Files

| Path | Purpose |
|------|---------|
| `tools/perf/src/cli.ts` | Entry point (`atlas-perf profile` / `atlas-perf analyze`) |
| `tools/perf/src/profiler.ts` | Spawns node with `--cpu-prof`, manages output |
| `tools/perf/src/profile-parser.ts` | Reads `.cpuprofile`, builds call tree, computes times |
| `tools/perf/src/domain-classifier.ts` | Maps V8 script URLs to Atlas domain names |
| `tools/perf/src/report-formatter.ts` | Formats the analysis into structured text |
| `tools/perf/src/types.ts` | TypeScript interfaces for profile data |

## Common Bottleneck Patterns

### Encryption too slow
- **Symptom**: `node:crypto` + `@wisecom/atlas-core/crypto` > 30% self-time
- **Root cause**: scrypt key derivation runs per-message instead of once per session
- **Fix**: Cache the derived KEK for the session lifetime (already done via TenantContext)

### S3 uploads blocking
- **Symptom**: `@wisecom/atlas-s3` high self-time, especially MD5/checksum computation
- **Root cause**: ContentMD5 computed synchronously for each object
- **Fix**: Stream-based checksums or worker thread offload

### Graph API client overhead
- **Symptom**: `@wisecom/atlas-m365-graph` or `ms-graph-sdk` high self-time
- **Root cause**: Response parsing, token refresh serialization
- **Fix**: Check if JSON parsing of large responses dominates; consider streaming

### Too many intermediate layers
- **Symptom**: Hot paths show 10+ frames of pass-through functions with zero self-time
- **Root cause**: Over-abstraction adding call overhead
- **Fix**: Inline hot-path intermediaries or reduce adapter layering
