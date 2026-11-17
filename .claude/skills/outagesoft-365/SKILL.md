---
name: outagesoft-365
description: >-
  Run Atlas against a deliberately unreliable Microsoft Graph and judge how it
  copes. Injects throttling (429, Retry-After), 5xx, timeouts, resets, truncated
  downloads, lost write responses, altered delta pages and timed workload outages,
  replays a failing run exactly, and reports correctness verdicts. Use for
  resilience, chaos or fault-injection testing of backup and restore.
when_to_use: >-
  The user asks to test Atlas resilience, simulate Graph or Microsoft 365
  outages, throttling, timeouts, flaky network or a degraded service, run chaos
  or fault-injection tests, reproduce or regression-test a failure seen under
  faults, check Retry-After or backoff handling, check for duplicate writes on
  retry, or asks whether a backup survived (or stayed complete through) a bad
  Graph.
---

# outagesoft-365

Runs a command with its Microsoft 365 traffic re-routed through a local relay that
injects faults, journals every exchange, and writes a report whose verdict table
says whether the client behaved correctly. Atlas needs no change.

`tools/outagesoft-365/outagesoft-365`. Tested on Linux (WSL Ubuntu), Node 22.22.2
or later. Run directories and the identity key live in `.outagesoft-365/` at the
repository root, wherever in the repository you start it. Depth:
`docs/development/outagesoft-365.md`.

## Safety rules, before anything else

- **Ask before every run that is not against a test tenant.** Faults reach the real
  tenant. `drop_next_link` makes a backup incomplete; `lost_response` on a POST
  lets the write commit and hides the answer, so a retry duplicates it. Restores
  and other writes under `lossy`, `chaos`, or any profile containing
  `lost_response` must be confirmed by the user.
- **Never set `NODE_TLS_REJECT_UNAUTHORIZED`**, and never suggest it. The relay
  needs no certificate; the client speaks plain HTTP to 127.0.0.1 and the relay
  does normal TLS upstream. Atlas refuses to start with it set to `0`.
- **`--upstream` receives bearer tokens and client secrets.** Only point it at a
  local fake you started. It accepts https, or http to loopback only.
- **Never paste run directory contents, journal lines, the identity key, or tenant
  identifiers into an issue, PR, or commit.** Redaction templates ids, paths,
  sites, tenants and quoted literals, but unquoted values of unknown query
  parameters are kept as sent, and the opening lines print an absolute path with a
  username. Quote verdicts, counts, fault ids,
  status codes and shapes with `user@example.com` / `contoso` substituted.
- **Never set `OUTAGESOFT_TEST_FORCE`.** It is for the selfcheck.

## Always start with doctor

```bash
./tools/outagesoft-365/outagesoft-365 doctor
```

Show the user the result. Every line must lack `(PROBLEM)`: node version,
`fetch dispatcher`, `fetch re-route`, `node:https` (the token re-route). If
`TLS` says `NODE_TLS_REJECT_UNAUTHORIZED=0 is set`, stop and ask the user to unset
it. Do not work around a failing re-route; report it.

## Pick a profile for the question

| Question                                                  | Run                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Baseline for any comparison                               | `--profile passthrough`                                                                       |
| Does it honour Retry-After, back off, survive throttling? | `--profile throttled`                                                                         |
| General smoke test of retries                             | `--profile flaky` (default, about 3 %); add `--intensity 5` for a short workload              |
| Timeouts, hangs, slow downloads                           | `--profile degraded`                                                                          |
| Resets, truncated downloads, duplicate writes             | `--profile lossy` (test tenant only)                                                          |
| Delta resync, expired tokens, duplicate or missing items  | `--profile inconsistent` (test tenant only)                                                   |
| One workload down while others work                       | `--outage outlook:30s:2m` (or `--profile outage --service outlook`)                           |
| Token acquisition failing                                 | `--outage identity:0s:1m`                                                                     |
| One specific fault                                        | a profile that contains it plus `--faults <id>` and `--intensity`; otherwise `--profile-file` |
| Everything at once                                        | `--profile chaos` (test tenant only)                                                          |

`--faults` and `--exclude-faults` only filter the chosen profile's rates; they
cannot add a fault the profile lacks. `./tools/outagesoft-365/outagesoft-365
profiles` and `faults` print the rates and the catalog.

## Always record a seed

Pass `--seed <value>` on every faulted run and tell the user the seed and the run
directory. A seed plus profile reproduces the same fault on the same attempt of the
same request whatever the concurrency. Outage windows are time-based and do not;
`--replay` does.

## The loop: baseline, faulted, compare, fix, replay

```bash
T=./tools/outagesoft-365/outagesoft-365
CMD="node packages/cli/dist/cli.mjs outlook backup -m user@example.com"

$T run --profile passthrough --out .outagesoft-365/baseline -- $CMD
$T run --profile throttled --seed 42 --out .outagesoft-365/faulted \
  --verify-cmd "<script that verifies the snapshot this run wrote>" -- $CMD
$T compare .outagesoft-365/baseline .outagesoft-365/faulted
# ...fix Atlas, rebuild...
$T run --replay .outagesoft-365/faulted --out .outagesoft-365/after-fix -- $CMD
$T compare .outagesoft-365/baseline .outagesoft-365/after-fix
```

- `run` passes the command's exit code through and always writes a journal and a
  report, so a failed backup is still evidence. Exit 64 means the tool rejected
  its own arguments (nothing ran); 70 means the tool itself failed. Neither is
  Atlas's result.
- `--replay` takes profile, seed, intensity, outages and filters from the source
  run and refuses them on the command line. Pass `--upstream`, `--max-hold`,
  `--out` and `--verify-cmd` again if you need them.
- A replay that reports `not_encountered > 0` (verdict 9 WARN) means the client
  now makes different requests. Say so; it is not a faithful regression test.
- Replay matches requests by identity: pages by their ordinal in the listing,
  upload fragments by session ordinal and offset, small JSON writes by a body
  digest. Large or chunked write bodies match by URL only.
- Replays and compares only work on the same checkout (same identity key).

## Read the report: verdicts first

The terminal summary lists every non-PASS verdict; `report.md` opens with the full
table. Every verdict except 8 and 9 is **inferred from traffic**: a re-request of
the same URL is taken to be a retry. Say that when you report a verdict, and check
the evidence column before calling something a bug.

| Verdict                                 | What a non-PASS means                                                                                                | Check next in Atlas                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 Retry-After respected, FAIL           | A retry came more than 250 ms before the advised wait                                                                | `retry_delay_ms` and `extract_retry_after_ms` in `packages/m365-graph/src/`; a path that bypasses `with_graph_retry` |
| 2 Backoff when no Retry-After, WARN     | Retries after 429/5xx without the header came immediately or never grew                                              | The same retry loop; a caller with its own retry                                                                     |
| 3 Retries are safe, FAIL / WARN         | A POST, or PATCH without If-Match, was re-sent after an ambiguous outcome; FAIL means the first reached the upstream | Restore and write paths. Atlas retries 5xx and resets for writes too. Token requests never count here                |
| 4 No duplicate processing, WARN         | Finished work was fetched again                                                                                      | Whether a retry restarted a whole loop instead of one page; polling endpoints also land here                         |
| 5 Resumed from a valid checkpoint, WARN | A faulted paged request restarted or moved on without a 410 / `syncStateNotFound`, or was abandoned                  | Per-page retry and nextLink resume; `is_invalid_delta_error`                                                         |
| 6 Corrupt answers, FAIL                 | A malformed, empty, or truncated body was never re-requested and the child exited 0                                  | Parse and length handling around the shapes listed                                                                   |
| 6 Corrupt answers, NEEDS EVIDENCE       | `drop_next_link`, `duplicate_items` or `shuffle_items` applied; invisible on the wire                                | Run `compare` against a baseline; check `--verify-cmd`                                                               |
| 7 Every faulted request satisfied, FAIL | A request never got a usable response yet the child exited 0: a swallowed failure                                    | Error handling that logs and continues; partial-failure exit codes                                                   |
| 8 Backup verifiably complete            | NEEDS EVIDENCE: no `--verify-cmd`. FAIL: it exited non-zero                                                          | Re-run with `--verify-cmd`, then `compare`                                                                           |
| 9 Replay fidelity, WARN                 | Scheduled faults were not applied                                                                                    | The client's request pattern changed; see `run.json` `replay`                                                        |

NOT OBSERVED is not a pass: the run never gave the client the chance. Choose a
profile that exercises it, or raise `--intensity`, rather than reporting success.

After the verdicts, use the report sections: "How the client responded" (retry
chains per fault, Retry-After gaps, inferred timeouts, duplicate write risk),
"Outage windows" (recovery time), "What was injected" (including skipped mutations
and why). Atlas races a 60 s per-attempt timeout instead of aborting, so a client
timeout shows as a new attempt while the old one is still open, listed under
"Inferred timeouts", not as `client_closed`.

## When to reach for which option

- `--verify-cmd "<cmd>"`: on every run that should answer "is the backup
  complete?". It runs after the command, without the relay, against the real
  service. `atlas outlook verify` proves stored data is intact, not that a listing
  was complete, so pair it with `compare`.
- `--outage svc:start:dur[:fault]`: one workload down for a period. The fault must
  be synthetic (default `unavailable_503`). Start counts from the first relayed
  request.
- `--services a,b`: confine random faults to the workload under test. Every
  `$batch` is classified `directory`, so neither `--services outlook` nor an
  `outlook` outage reaches batched mailbox calls.
- `--faults a,b` / `--exclude-faults a,b`: narrow a profile, for example drop
  `lost_response` from `lossy` when writes are not under test.
- `--upstream <url>`: a local fake Graph only (see safety rules).
- `--max-hold <dur>`: cap injected waits (default 120 s) to keep runs short.
- `--quiet`: suppress per-request stderr lines on long runs.

Ctrl-C at a terminal goes straight to the command (the tool does not forward a
second one), and an interrupted run skips `--verify-cmd`.

## What not to do

- **Do not combine with graph-tap.** Under the relay, graph-tap sees requests to
  127.0.0.1 and captures nothing useful. The report's "Compare with real behaviour"
  block gives the same aggregates.
- **Do not read `journal.jsonl` wholesale.** Grep it for one fault, status or
  shape: `grep '"id":"lost_response"' <run-dir>/journal.jsonl`. `report` is the
  aggregate.
- **Do not claim a fix from one random run.** Use `--replay` of the failing run.
- **Do not treat a zero-request run as a pass.** The report warns loudly when the
  preload did not engage; check `doctor` and that the command is a Node process.

## If you change the tool

Run `./tools/outagesoft-365/outagesoft-365 selfcheck` before reporting a change as
working. It needs no network or credentials, finishes in seconds, and must print no
`FAIL` line. After touching `tools/graph-tap/redact.mjs`, also run
`./tools/graph-tap/graph-tap selfcheck`.
