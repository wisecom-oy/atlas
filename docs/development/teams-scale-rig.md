# Teams scale rig

The scale rig runs the real Teams backup against a fake Microsoft Graph server with a synthetic tenant. It measures request volume, throttling, memory, and resume behaviour without a Microsoft 365 tenant. Use it to check changes to pacing, checkpoints, or hosted content handling before they reach a real tenant.

```bash
pnpm install
pnpm run rig:teams sync --time-scale 10
```

The rig lives in `tools/teams-scale-rig/`. It is plain ESM with no build step, like [Graph request tracing](/development/graph-tap).

## Options

| Option | Default | Meaning |
|---|---|---|
| `--teams N` | `100` | Teams in the synthetic tenant. |
| `--channels-per-team N` | `10` | Channels per team. |
| `--time-scale K` | `1` | Graph budgets scale by `K`, so a run finishes roughly `K` times faster. |
| `--seed S` | `586` | Fixture seed. The same seed produces the same tenant. |
| `--concurrency C` | `4` | Channels per team in flight, `1` to `16`, as in `atlas teams backup`. |
| `--parallel-teams N` | `5` | Teams backed up at once on the rig host, `1` to `64`. Production runs teams one after another, so `1` matches it. |
| `--store DIR` | `<tmp>/atlas-teams-rig-<seed>` | Where encrypted backup output is written. Each scenario wipes its own subfolder. |
| `--json` | off | Also print the raw result as JSON. |

The default fixture is about 1,000 channels across 100 teams. It has long threads, roughly 5% of messages with inline hosted images, deleted messages, and content older than the 8-month delta window.

## Scenarios

| Command | What it does |
|---|---|
| `pnpm run rig:teams sync` | First full sync, an unchanged rerun, then a mutated rerun on the same store after the tenant changes. The mutated rerun is compared with a fresh backup of the mutated tenant. |
| `pnpm run rig:teams kill-resume` | Kills a backup process with SIGKILL partway through, reruns it on the same store, and compares the result with a clean run. |
| `pnpm run rig:teams throttle-isolation` | Throttles one team on the fake server while another team backs up on the same container. |

Each scenario prints one table per run and a list of checks. The process exits `1` if any check fails. If the backup requests a route the fake server does not serve, the run stops at once with exit `1`, so a missing route never looks like a passing check.

### sync

The first run downloads every reachable hosted image. The unchanged rerun downloads none, reports the same channel count, and reads each channel with one delta request. The mutation adds replies with images, edits one root, and deletes one root. The mutated rerun downloads exactly the new images, reads through delta with no full listing, and its live content matches the fresh backup. Deleted roots are compared only for being deleted. Their deletion time and reply sets are ignored, because an observed removal is dated by the backup time and keeps the stored replies, while a fresh read carries Graph's own deletion time.

### kill-resume

The backup runs in a child process that the rig kills with SIGKILL once it has downloaded a quarter of the expected hosted images. The rig then:

- counts the hosted blobs in the store when the child died,
- expires the team leases the child could not release, as their five-minute TTL would, so the resume takes them over instead of waiting for them to run out,
- reruns the backup on the same store and checks that it does not download any blob the store held at the kill,
- checks that every blob the final snapshot references is either stored at the kill or downloaded on resume,
- runs a control backup on a fresh store and checks the two converged snapshots match.

The passphrase is generated per run and passed to the child through the `ATLAS_TEAMS_RIG_PASSPHRASE` environment variable. Nothing secret is stored in the repository.

### throttle-isolation

Team A gets half of its per-team budget on the fake server, scaled by `--time-scale`. Team B runs alone first to get a baseline, then runs alongside A on the same container. Two checks apply:

- Team A received 429 responses. Without this the scenario proves nothing.
- Team B's wall time stays within 1.5 times its solo time plus 2 seconds.

The tenant-wide buckets are shared, so some slowdown for B is expected. The check bounds it. It does not expect none.

## What the server enforces

The fake server applies the same Teams limits the pacer assumes, taken from `GRAPH_SERVICE_LIMITS.teams` in `packages/types`, each multiplied by `--time-scale`:

| Bucket | Limit |
|---|---|
| Tenant, message reads | 20 requests per second |
| Per channel, message reads | 1 request per second |
| Tenant, default | 30 requests per second |
| Per team, default | 4 requests per second |

Requests over a bucket get `429 Too Many Requests` with a `Retry-After` header. The header is in whole seconds and never below 1 second. Its value is the time until a token refills at the scaled rate, rounded up, so at high `--time-scale` values the rig's timing is approximate. Denied requests do not spend tokens.

The server also serves paged collections with `@odata.nextLink`, returns replies past 10 per thread through `replies@odata.nextLink`, and filters delta results to the 8-month window.

## Reading the report

Each run prints:

- wall time at the stated time scale, and the channel count,
- per class (`messages`, `default`): attempts, admitted, and 429 counts,
- real and simulated requests per second. Simulated means the rate scaled back by `--time-scale`, so it can be compared with the production budget,
- the hottest team by 429 count,
- hosted images downloaded and bytes,
- peak RSS and peak heap, sampled every 100 ms.

Use `--json` when you need the full counters for a comparison script.

## Limits of the rig

- It proves behaviour against the modelled limits, not Microsoft's actual throttling. Treat its rps numbers as a regression signal, not a capacity forecast.
- Storage is the local filesystem with the same envelope encryption as the S3 adapter. Object Lock is not exercised.
- The rig uses its own Graph client chain with an origin rewrite, so it does not run the production Graph middleware stack.
- Filesystem storage cannot hold a key that is both an object and a prefix. Teams keys do not do this.
- The fixture team IDs are fixed and synthetic. The rig never lists teams from a real tenant.

## Selfcheck

The pure parts (fixture generation and mutation, rate limiting, paging tokens, reply inlining, and argument parsing) have a check that needs no network and no backup run. It reads limits from the workspace types package, so run `pnpm install` first:

```bash
node tools/teams-scale-rig/src/selfcheck.mjs
```

See also: [Performance profiling](/development/performance-profiling), [Teams backup](/teams-backup).
