# Performance Profiling

Atlas includes built-in CPU profiling tooling that instruments the backup and restore pipelines to identify bottlenecks. The profiler generates structured text reports designed for both human review and automated analysis.

## Quick Start

```bash
# Build the profiler (once, or after changes to tools/perf/)
pnpm run perf:build

# Profile a single-mailbox backup
pnpm run perf:backup -- -m user@example.com

# Profile a restore
pnpm run perf:restore -- -s <snapshot-id> -m target@example.com

# Analyze a previously captured .cpuprofile
pnpm run perf:analyze -- .perf-output/CPU.20260506.123456.12345.0.001.cpuprofile
```

## How It Works

The profiler uses Node.js built-in V8 CPU profiling (`--cpu-prof`) to sample the call stack at 500-microsecond intervals while Atlas runs. After the process exits, the captured `.cpuprofile` is parsed into an aggregated report.

```
atlas CLI process
    |
    v
node --cpu-prof --cpu-prof-dir=.perf-output packages/cli/dist/cli.js backup ...
    |
    v
.perf-output/CPU.*.cpuprofile   (raw V8 profile)
    |
    v
atlas-perf analyze              (parser + formatter)
    |
    v
Structured text report          (stdout)
```

## Report Sections

### Top Functions by Self-Time

Shows the functions where CPU is actually consumed (excluding time in their callees). A function with high self-time is doing expensive work directly.

| Column | Meaning |
|--------|---------|
| Self ms | Milliseconds spent in this function only |
| Self % | Proportion of total profiled time |
| Total ms | Time including all callees |
| Function | Function name |
| Location | File path and line number |

### Domain Breakdown

Aggregates all functions by their Atlas package, giving a high-level view of where compute time goes:

| Domain | What it covers |
|--------|---------------|
| `@wisecom/atlas-core/crypto` | Key derivation (scrypt), AES-256-GCM encrypt/decrypt |
| `@wisecom/atlas-s3` | S3 PutObject/GetObject, MD5 checksum, client operations |
| `@wisecom/atlas-m365-graph` | Graph client factory, rate limiting, retry logic |
| `@wisecom/atlas-outlook/backup` | Folder sync, delta processing, attachment storage |
| `@wisecom/atlas-outlook/restore` | Message reconstruction, folder creation, uploads |
| `node:crypto` | Native crypto primitives (called by core/crypto) |
| `node:network` | TLS handshakes, HTTP framing, TCP |
| `aws-sdk` | AWS SDK v3 internals |
| `ms-graph-sdk` | Microsoft Graph client library |

### Hot Paths

The critical call chains from entry to the heaviest leaf. Each path follows the most expensive branch at every call site, revealing the dominant execution flow.

### Observations

Auto-generated summary noting the proportion of time spent in crypto, S3, Graph, and network subsystems.

## Flamegraph Mode

For interactive visual analysis, use the `--flamegraph` flag (requires `0x` installed as a dev dependency):

```bash
node tools/perf/dist/cli.js profile --flamegraph -- backup -m user@example.com
```

This generates both the `.cpuprofile` text report AND an interactive HTML flamegraph in `.perf-output/`.

## Limitations

**CPU profiles only capture compute time.** Network I/O (waiting for Graph API responses, waiting for S3 uploads to acknowledge) appears as idle time and is NOT reflected in the profile. The profile answers "what is burning CPU?" not "what is the process waiting on?"

For I/O-bound bottleneck analysis:
- Use the `elapsed_ms` timers already present in backup/restore output
- Compare total wall-clock time vs CPU time -- a large gap indicates I/O dominance
- Add targeted `performance.now()` spans around suspected network operations

## Profiling Tips

- **Profile with realistic data**: A single-message backup won't reveal concurrency bottlenecks. Use a mailbox with 50+ messages and attachments.
- **Compare before/after**: Always capture a baseline profile before optimizing, then re-profile after to validate the improvement.
- **Check sample count**: If the report shows very few samples (<100), the operation completed too fast for meaningful profiling. Use a larger dataset.
- **Mind the overhead**: CPU profiling adds ~5% overhead. The absolute numbers are slightly inflated, but relative proportions remain accurate.

## Architecture

The profiling tool lives in `tools/perf/` (not a published package):

```
tools/perf/
  src/
    cli.ts                 # Commander CLI: 'profile' and 'analyze' subcommands
    profiler.ts            # Spawns node with --cpu-prof, manages artifacts
    profile-parser.ts      # Parses .cpuprofile JSON, builds call tree
    domain-classifier.ts   # Maps V8 script URLs to Atlas domain names
    report-formatter.ts    # Renders analysis as structured text
    types.ts               # TypeScript interfaces
  package.json
  tsconfig.json
```

Output artifacts are written to `.perf-output/` (git-ignored).
