---
description: Run Atlas against a deliberately unreliable Microsoft Graph with outagesoft-365, replay a failing run exactly, and read correctness verdicts on how the client coped.
---

# Graph Fault Injection

`outagesoft-365` runs a command with its Microsoft 365 traffic re-routed through a
local relay that injects faults: throttling, 5xx errors, resets, stalls, truncated
bodies, lost write responses, altered delta pages, and timed outages of a single
workload. It records every exchange, can replay the same faults onto the same
requests later, and writes a report that judges how the client behaved.

Graph fails in ways a test tenant on a quiet afternoon never shows. Retry logic,
checkpointing, and completeness are only exercised when something goes wrong, and
waiting for production to go wrong is not a test plan.

This is a development tool. It is not part of the `atlas` CLI or any published
package.

::: danger Test tenants only
Some faults damage the tenant or the backup by design. `drop_next_link` ends a
listing early, so a backup taken under it is incomplete. `lost_response` on a
write lets the write commit and then hides the answer, so a client that retries
creates the item twice. Run faulted restores and other writes only against a
tenant you can afford to clean up.
:::

## Quick start

```bash
# 1. Check the runtime first. It needs nothing but Node.
./tools/outagesoft-365/outagesoft-365 doctor

# 2. Baseline: the same workload with no faults.
./tools/outagesoft-365/outagesoft-365 run --profile passthrough --out .outagesoft-365/baseline \
  -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com

# 3. Faulted run with a fixed seed.
./tools/outagesoft-365/outagesoft-365 run --profile throttled --seed 42 --out .outagesoft-365/throttled \
  -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com

# 4. What the baseline fetched that the faulted run never did.
./tools/outagesoft-365/outagesoft-365 compare .outagesoft-365/baseline .outagesoft-365/throttled

# 5. After a fix: the same faults on the same requests.
./tools/outagesoft-365/outagesoft-365 run --replay .outagesoft-365/throttled \
  -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com
```

`run` prints a summary when the command exits and writes `report.md` beside the
journal. It passes the command's exit code through, so a failed backup still
leaves a journal and a report. Without `--out`, runs go to
`.outagesoft-365/<UTC timestamp>/` in the repository root (gitignored).

The tool's home is `.outagesoft-365/` in the nearest ancestor of the working
directory that contains `.git`, so a run started from `packages/cli` shares run
directories and the identity key with one started from the root. Outside a
repository it falls back to the working directory.

## How interception works

`run` starts the relay on `127.0.0.1`, then starts the command with a preload
appended to `NODE_OPTIONS` (`--import`). `NODE_OPTIONS` reaches every Node process
in the tree, so `pnpm`, workers, and the CLI are all covered. Atlas needs no change
and no flag.

**Graph and transfer traffic.** Atlas reaches Graph and the pre-authenticated
download and upload URLs through the global `fetch`, which in Node is undici. The
preload replaces undici's global dispatcher with a composed one that rewrites
requests for Microsoft 365 origins to the relay, prefixing the path with a per-run
token and the original origin. Headers are untouched, `response.url` still reports
the real URL, and redirects pass through the same dispatcher, so they are
re-routed too.

**Token traffic.** `@azure/identity` does not use `fetch`. Its HTTP client calls
`node:https`, so the preload also wraps `https.request` and `https.get`: a call for
`login.microsoftonline.com` is sent with plain `http.request` to the relay instead.
Every other host goes to the original function untouched.

**Why no certificate is needed.** The client never speaks TLS to the relay. The
hop from the client to `127.0.0.1` is plain HTTP inside one machine, and the relay
opens its own TLS connection to the real host with Node's default certificate
validation. Nothing is impersonated, so there is no CA to trust.

**Why `NODE_TLS_REJECT_UNAUTHORIZED` is never touched.** Disabling validation would
let anyone on the network path read a bearer token, and Atlas refuses to start when
it is `0`. The relay never sets or needs it, and `doctor` reports it if your shell
has it set.

Only these hosts are re-routed: `graph.microsoft.com`, `login.microsoftonline.com`,
`*.sharepoint.com`, `1drv.com`, `1drv.ms`, `*.1drv.com`, `*.1drv.ms`,
`officeapps.live.com` with its subdomains, and `outlook.office.com` and
`outlook.office365.com`, which serve Outlook attachment upload sessions. S3 traffic
is never touched.

If the preload cannot install a re-route, it prints one `[outagesoft-365]` warning
and leaves traffic direct rather than break the command. A run that relayed nothing
says so in the report:

```text
! No requests were relayed. The preload did not engage, so the child reached Microsoft 365 directly or not at all, and nothing in this report describes how it handles faults.
```

### Classification

Every request is classified from its host and path, never its body, into a service
and a kind. Faults, `--services`, and outage windows select on these.

| Service      | Requests                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| `outlook`    | `users/{id}/` or `me/` messages, mail folders, events, calendars, contacts |
| `onedrive`   | `/drives/`, `/shares/`, `users/{id}/drive`                                 |
| `sharepoint` | `/sites/`                                                                  |
| `teams`      | `/teams/`, `/chats/`, joined teams and channels                            |
| `directory`  | anything else on `graph.microsoft.com`, including every `$batch`           |
| `identity`   | `login.microsoftonline.com`                                                |
| `transfer`   | pre-authenticated download and upload hosts, Outlook upload sessions       |

The selector `graph` means every service except `identity`; `all` means everything.
Kinds are `delta`, `batch`, `download`, `upload`, `token`, `write` (any other
non-GET), and `read`.

## Profiles

```bash
./tools/outagesoft-365/outagesoft-365 profiles
```

| Profile        | Severity | Total rate | Mix                                                                                                              |
| -------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `passthrough`  | 0        | 0 %        | No faults. The baseline for `compare`.                                                                           |
| `flaky`        | 1        | about 3 %  | Mostly `throttle_429`, a few 503, 504, resets, slow first bytes. The default.                                    |
| `throttled`    | 2        | about 15 % | 429 with and without Retry-After, 503 with Retry-After, rare long Retry-After, batch inner 429s                  |
| `degraded`     | 3        | about 40 % | Latency: slow first bytes (20 %), slow bodies, 504s, hangs, reordering, light 5xx                                |
| `lossy`        | 3        | about 12 % | Transport loss: resets, truncated bodies, hangs, lost responses                                                  |
| `inconsistent` | 3        | about 16 % | Wrong answers: duplicates, shuffles, bad JSON, empty bodies, dropped nextLink, expired delta state, spurious 4xx |
| `brownout`     | 4        | about 30 % | Mixed 5xx including HTML 503s, throttling, resets, slowness                                                      |
| `outage`       | 5        | about 3 %  | `flaky` plus a 60 s `unavailable_503` outage of `--service` (default `graph`) from 20 s                          |
| `chaos`        | 5        | about 27 % | Every fault in the catalog at moderate rates                                                                     |

Rates are per eligible request: a fault only lands where it applies, so a 2 %
`delta_resync_410` hits 2 % of delta requests, not 2 % of all traffic. Each request
gets at most one fault. `--intensity` multiplies every rate, and the total is then
scaled down proportionally to stay at or below 95 %. `run.json` records the
effective rates, not the nominal ones.

A custom profile has the same shape as the built-ins and is loaded with
`--profile-file`. Unknown keys and unknown fault ids are errors, so a typo cannot
silently produce a clean run:

```json
{
  "id": "short-waits",
  "severity": 3,
  "rates": { "throttle_429": 0.1, "drop_next_link": 0.05 },
  "params": { "throttle_429": { "retry_after_s": [1, 3] } },
  "outages": [
    { "service": "outlook", "start_ms": 30000, "duration_ms": 120000, "fault": "no_response" }
  ]
}
```

`params` overrides a fault's defaults with a number, a `[min, max]` range, or
`{ "choice": [...] }`. Outages in a profile file are in milliseconds.

## Fault catalog

```bash
./tools/outagesoft-365/outagesoft-365 faults
```

Synthetic faults are answered by the relay; the request never reaches Microsoft 365.
Forwarded faults let the request through and disturb the response. Error bodies use
Graph's wire shape, including the `innerError` block with `date`, `request-id`, and
`client-request-id`, because client code branches on the code, the inner code, the
status, and whether Retry-After is present.

Atlas's retry policy (`packages/m365-graph/src/graph-request-error-handler.ts`)
decides what most of these test. It retries 429, 500, 502, 503, 504, and network
errors such as `ECONNRESET`, `ETIMEDOUT`, and undici's `terminated`, up to 12
times. Without Retry-After it backs off exponentially from 1 s with jitter, capped
at 5 minutes. A Retry-After is honoured exactly, and one above 300 s fails the call
at once instead of waiting. Each attempt has a 60 s timeout that races the request
promise rather than aborting it.

### Throttle

| Fault                           | Client sees                                                                                                                                                                                               | Real-world behaviour                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `throttle_429`                  | 429, Retry-After 5 to 30 s. Outlook: `ApplicationThrottled`, "Application is over its MailboxConcurrency limit." Drives: `activityLimitReached` with inner `throttledRequest`. Others: `TooManyRequests`. | Graph throttles with 429 and Retry-After, and Microsoft's guidance is to honour the delay. Outlook allows 10,000 requests per 10 minutes and 4 concurrent requests per app per mailbox. |
| `throttle_429_no_retry_after`   | The same 429 without Retry-After                                                                                                                                                                          | Some workloads return 429 without Retry-After.                                                                                                                                          |
| `throttle_429_long_retry_after` | 429 with Retry-After 315 to 3570 s                                                                                                                                                                        | OneDrive and SharePoint have advised waits from minutes up to about an hour. Exercises Atlas's fail-fast path above 300 s.                                                              |
| `throttle_503`                  | 503 `serviceNotAvailable` with Retry-After 5 to 30 s; "Server Too Busy" on drives                                                                                                                         | OneDrive and SharePoint also throttle with 503 and Retry-After.                                                                                                                         |
| `batch_inner_429`               | A 200 `$batch` whose sub-responses include 429s with Retry-After                                                                                                                                          | Throttled sub-requests in a JSON batch come back as 429 inside a 200.                                                                                                                   |
| `token_endpoint_429`            | 429 from the token endpoint, Retry-After 60, OAuth error body                                                                                                                                             | Stress case for token acquisition; identity requests only.                                                                                                                              |

### Server

| Fault                 | Client sees                                                                       | Real-world behaviour                                                                        |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bad_gateway_502`     | 502 `UnknownError` with an empty message                                          | Heavy queries return 502 and 504 with `UnknownError` and an empty message.                  |
| `gateway_timeout_504` | A wait of 5 to 20 s, then 504 `UnknownError` with an empty message                | As above.                                                                                   |
| `html_503`            | 503 `text/html` IIS page "The application request queue is full.", no Retry-After | 503 responses with an HTML IIS body instead of JSON have been reported.                     |
| `mailbox_backend_503` | 503 `MailboxInfoStale`, database on backend `Unknown` (Outlook only)              | `MailboxInfoStale` 503s have hit mail endpoints while other Graph endpoints stayed healthy. |
| `unavailable_503`     | 503 `serviceNotAvailable`, no Retry-After                                         | Stress case. The default fault of an outage window.                                         |
| `server_500`          | 500 `generalException` on drives, `InternalServerError` elsewhere                 | Stress case.                                                                                |
| `token_endpoint_503`  | 503 `temporarily_unavailable` (AADSTS90033), no Retry-After                       | Stress case for token acquisition; identity requests only.                                  |

### Auth

| Fault                      | Client sees                                                                                | Real-world behaviour                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `spurious_401`             | 401 `InvalidAuthenticationToken`, "Lifetime validation failed", `WWW-Authenticate: Bearer` | Spurious 401s on fresh tokens are reported.                |
| `download_url_expired_401` | 401 "JWT Token Expired" on a pre-authenticated download (GET, transfer hosts)              | Pre-authenticated download URLs can expire within minutes. |

### Consistency

| Fault                     | Client sees                                                                                                        | Real-world behaviour                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `delta_resync_410`        | 410 `resyncRequired` (drives: inner `resyncChangesApplyDifferences`) with a `Location` header                      | Delta queries can return 410 Gone asking for a resync.           |
| `delta_token_expired`     | 410 or 400 `syncStateNotFound`                                                                                     | Expired delta tokens return `syncStateNotFound`.                 |
| `transient_404`           | 404 for an item that exists: `ErrorItemNotFound` (Outlook), `Request_ResourceNotFound` (directory), `itemNotFound` | A 404 right after creation (eventual consistency) is documented. |
| `upload_session_gone_404` | 404 `itemNotFound` with inner `uploadSessionNotFound` on a fragment PUT                                            | Upload sessions expire.                                          |
| `upload_fragment_416`     | 416 `invalidRange` with inner `fragmentOverlap` on a fragment PUT                                                  | Overlapping fragments return 416.                                |
| `spurious_400`            | 400 `invalidRequest` for a valid request                                                                           | Stress case.                                                     |
| `locked_423`              | 423 `notAllowed` with inner `resourceLocked` (drives only)                                                         | Stress case.                                                     |

### Transport

| Fault              | Client sees                                                                                                   | Real-world behaviour                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `connection_reset` | The socket is destroyed before any response                                                                   | Clients report connection resets.                                                                        |
| `no_response`      | The request is accepted and nothing is sent; the socket closes after 90 s                                     | Very slow responses on large mailboxes. 90 s outlasts Atlas's 60 s attempt timeout.                      |
| `slow_first_byte`  | The request is forwarded after 2 to 15 s                                                                      | Very slow responses on large mailboxes and MIME downloads.                                               |
| `slow_body`        | The body arrives at 2 to 16 KiB/s for up to 60 s, then at full speed                                          | As above.                                                                                                |
| `truncated_body`   | Headers and 10 to 90 % of the body, then the socket is destroyed (undici: `terminated`)                       | Downloads cut off mid-transfer.                                                                          |
| `lost_response`    | The upstream completes the request, then the client socket is destroyed without an answer. Never on downloads | A write that succeeded but whose response was lost is duplicated on retry. Graph has no idempotency key. |

### Content and ordering

Mutations buffer only `application/json` responses up to 4 MiB. When a mutation
cannot apply (wrong content type, too large, no `value` array, no nextLink) it is
recorded as skipped with the reason and the response is forwarded unchanged.

| Fault             | Client sees                                                                 | Real-world behaviour                                                              |
| ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `duplicate_items` | 1 to 3 elements of `value` repeated (GET)                                   | The same item can appear more than once in a delta feed.                          |
| `shuffle_items`   | `value` reordered (GET)                                                     | Order is not guaranteed.                                                          |
| `drop_next_link`  | `@odata.nextLink` removed from a page that had one (GET)                    | Stress case for completeness. Destructive: the rest of the listing is never read. |
| `malformed_json`  | The JSON cut at 5 to 95 %, with a matching `content-length` (GET)           | Stress case: a parse error rather than a transport error.                         |
| `empty_body_200`  | Status and headers kept, zero-length body (GET)                             | Stress case.                                                                      |
| `out_of_order`    | A finished response held until 2 later responses overtook it, or 3 s passed | Stress case for code that assumes responses arrive in request order.              |

A wait parameter (`delay_ms`, `hold_ms`, `max_ms`, `max_hold_ms`) never exceeds
`--max-hold`, which defaults to 120 s.

## Outage windows

```bash
./tools/outagesoft-365/outagesoft-365 run --outage outlook:30s:2m:no_response --seed 7 \
  -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com
```

`--outage service:start:duration[:fault]` fails every request to one service for a
period, starting the given time after the first relayed request so a slow startup
does not eat the window. Single workloads such as Exchange Online have had outages
lasting hours while the rest of Microsoft 365 stayed up; this is that case.

- The fault defaults to `unavailable_503` and must be synthetic and apply to every
  request of the service, so `slow_body` or `delta_resync_410` are rejected.
- The service may be a selector. `graph:1m:5m` takes all of Graph down but leaves
  token acquisition working.
- An `identity` outage maps a Graph-shaped fault to the token endpoint's own shape:
  throttle faults become `token_endpoint_429`, others `token_endpoint_503`.
  `connection_reset` and `no_response` apply as they are.
- An active outage wins over the profile's random fault. `--services` does not
  affect outages.
- `--outage` repeats. Durations take a unit: `1500ms`, `30s`, `2m`, `1h`.

The report gets an "Outage windows" table with the requests made to the service
during the window, attempts per URL, and the time from the window's end to the
first usable response.

Outage windows are timed, so the requests they hit depend on how fast the run went.
When you need the same requests hit again, replay the run.

## Deterministic replay

Two mechanisms make a failing run repeatable.

**Identity-keyed decisions.** A fault decision is drawn from a generator seeded by
the run seed, the request's identity, and how many times that identity has arrived
in this run. Arrival order plays no part, so the same seed and profile give the
n-th attempt of a given request the same fault whatever the concurrency. Every
seed is printed and recorded; without `--seed` a random one is chosen.

The base identity is the method, host, path with real IDs, and the query with
volatile parameters removed (delta and skip tokens, `tempauth`, SAS signatures) and
the rest sorted. Three refinements make it match what a person would call "the
same request":

| Request                                       | Added to the identity                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A page carrying a delta or skip token         | The page's ordinal within its listing, so page 3 differs from page 2 while a retried page keeps its number                        |
| An upload fragment (PUT to an upload session) | The session's ordinal in order of first arrival and the `Content-Range` start offset, since the session URL changes every session |
| A JSON POST, PATCH, or PUT up to 1 MiB        | A keyed digest of the body, so two different creates or two `$batch` calls in one folder are different requests                   |

A JSON body over 1 MiB, or one sent without `content-length`, keeps streaming and is
identified by URL only. The relay reads small JSON bodies before planning a fault
and streams everything else. Token request bodies are never digested.

Ordinals are assigned in order of first arrival. Pages of one listing and
fragments of one file arrive in sequence, so their ordinals are the same in every
run of the same workload.

**Exact replay.** `run --replay <run-dir>` reads that run's `run.json` and journal
and applies exactly the faults it applied, with the same parameters, to the same
attempt of the same request, outage-sourced faults included. Nothing else is
faulted and no outage windows are timed. The profile, seed, intensity, and filters
come from the source run, so `--replay` refuses `--profile`, `--profile-file`,
`--seed`, `--intensity`, `--outage`, `--service`, `--services`, `--faults`, and
`--exclude-faults`. `--upstream`, `--max-hold`, `--out`, and `--verify-cmd` are not
taken from the source; pass them again.

Divergence is reported rather than hidden. This replay ran a client that
downloaded 30 of the 40 items the source run downloaded:

```json
"replay": { "of": "faulted", "scheduled": 11, "applied": 10, "not_encountered": 1, "unscheduled_requests": 0 }
```

`not_encountered` counts scheduled faults whose request never came;
`unscheduled_requests` counts requests the source run never made. Either means the
client's behaviour or the tenant's contents changed. Verdict 9 is PASS only when
every scheduled fault was applied.

Replay works across runs on the same checkout only. Identities are keyed digests
under `.outagesoft-365/identity.key`, so a run directory copied from another machine
cannot be replayed there.

## Reading the report

A summary from a small synthetic workload under `flaky` at intensity 6:

```text
outagesoft-365 · profile flaky (severity 1) · seed 7 · intensity 6 · 34.0s
54 requests relayed · 11 faults injected (20.4 %) · 0 skipped · The child exited 0.
verdicts (inferred from traffic): 4 NOT OBSERVED, 5 PASS
  NOT OBSERVED   3 Retries are safe: No non-idempotent request ended ambiguously.
  NOT OBSERVED   5 Resumed from a valid checkpoint: No request carrying a delta or skip token was faulted.
  NOT OBSERVED   6 Corrupt answers were not accepted silently: No content fault was applied.
  NOT OBSERVED   9 Replay fidelity: Not a replay run.
- Of 8 requests failed by an injected fault, 8 recovered after a retry, 0 were retried and still failing at the end, and 0 were never requested again.
- All 4 retries after a Retry-After waited the advised time.
report: .outagesoft-365/<timestamp>/report.md
```

The terminal summary lists every check that did not pass. `report.md` opens with
the full verdict table, then:

| Section                     | Use it for                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                         | Profile, seed, outages, filters, child and verify exit codes                                                                                       |
| Timeline                    | Requests, faults, and failures in fixed buckets, with active outage windows                                                                        |
| How the client responded    | Retry chains per fault, Retry-After compliance, backoff gaps, client timeouts, duplicate write risk, content faults, requests that never recovered |
| Outage windows              | Per window: requests, attempts per URL, recovery time                                                                                              |
| What was injected           | Faults by id, category, and service, plus skipped mutations with reasons                                                                           |
| What was requested          | Request shapes, status mix as sent upstream and as received, latency unfaulted and faulted                                                         |
| Compare with real behaviour | The same aggregates `graph-tap summary` prints, to lay beside a capture of a real incident                                                         |
| Method and caveats          | How retries and timeouts were inferred                                                                                                             |

`report.json` holds the same data. `report` rebuilds both from a journal, by
default the newest run's:

```bash
./tools/outagesoft-365/outagesoft-365 report .outagesoft-365/throttled
```

### Correctness verdicts

| #   | Check                                           | FAIL or WARN when                                                                                                                                                                                                                       | Judged from                |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Retry-After respected                           | FAIL: a retry arrived more than 250 ms before the advised wait had passed                                                                                                                                                               | traffic                    |
| 2   | Backoff when no Retry-After                     | WARN: after a 429 or 5xx without Retry-After, one retry came within 100 ms, or two or more all came within 1 s with gaps that never grew                                                                                                | traffic                    |
| 3   | Retries are safe                                | FAIL: a POST, or a PATCH without If-Match, was re-sent after an ambiguous outcome that had reached the upstream. WARN: re-sent, but the first never reached it                                                                          | traffic                    |
| 4   | No duplicate processing                         | WARN: a GET that already completed cleanly was fetched again. Polling endpoints land here too, so never FAIL                                                                                                                            | traffic                    |
| 5   | Resumed from a valid checkpoint                 | WARN: a faulted delta or skip-token page restarted or moved on without a 410 or `syncStateNotFound`, or was abandoned                                                                                                                   | traffic                    |
| 6   | Corrupt answers were not accepted silently      | FAIL: a `malformed_json`, `empty_body_200`, or `truncated_body` response was never re-requested and the child exited 0. `drop_next_link`, `duplicate_items`, and `shuffle_items` are invisible on the wire, so they give NEEDS EVIDENCE | traffic                    |
| 7   | Every faulted request was satisfied or surfaced | FAIL: a faulted request never got a usable response and the child exited 0, so a failure was swallowed                                                                                                                                  | traffic                    |
| 8   | Backup verifiably complete                      | FAIL: the `--verify-cmd` command exited non-zero. NEEDS EVIDENCE without it                                                                                                                                                             | `--verify-cmd` exit code   |
| 9   | Replay fidelity                                 | WARN: a scheduled fault was not applied. Replay runs only                                                                                                                                                                               | `run.json` replay counters |

| Verdict          | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `PASS`           | The behaviour was exercised and was correct                               |
| `FAIL`           | Evidence of a defect: data loss, a swallowed failure, a duplicated write  |
| `WARN`           | Suspicious, but legitimate reasons exist                                  |
| `NEEDS EVIDENCE` | It happened, but traffic cannot judge it; use `--verify-cmd` or `compare` |
| `NOT OBSERVED`   | The run never gave the client the chance. Not a pass                      |

Verdicts 1 to 7 are inferences. A re-request of the same URL is taken as a retry,
and non-GET requests are also matched by a digest of the request body, so two
different writes to one URL stay apart. Because Atlas times out by racing a promise
rather than aborting the request, a client timeout usually appears as a new attempt
arriving while the old exchange is still open, not as a closed connection. The
report lists those under "Inferred timeouts".

Verdict 3 treats POST, and PATCH without If-Match, as non-idempotent. Token
requests are the exception: they change nothing, so a re-sent token request never
counts against it.

Completeness cannot be read from traffic. Verdict 8 needs `--verify-cmd`, and the
loss detector is `compare`.

## Compare against a baseline

```bash
./tools/outagesoft-365/outagesoft-365 compare .outagesoft-365/baseline .outagesoft-365/drop-pages
```

```text
outagesoft-365 compare · 13 requests against 46 in the baseline · 13 shared identities
LOST: 34 identities fetched in the baseline never succeeded here (1 always failed, 33 never requested)
     30  outlook  GET graph.microsoft.com/v1.0/users/{upn}/messages/{id}/$value
      3  outlook  GET graph.microsoft.com/v1.0/users/{upn}/mailFolders/inbox/messages/delta?$skiptoken=<2b>  pages 1, 2, 3
      1  outlook  GET graph.microsoft.com/v1.0/users/{upn}/mailFolders/inbox/messages/delta?$select=id
report: .outagesoft-365/drop-pages/compare.md
```

Here a profile with only `drop_next_link` cut a 40-item listing to its first page
of 10. The client exited 0 and saw nothing wrong. Paged requests are compared page
by page, and the lost pages are listed by ordinal.

`compare` lists every GET identity the baseline fetched successfully (2xx,
complete, no content fault) that the second run never fetched successfully,
grouped by service and request shape. It also lists identities only the second
run requested and the extra request volume per service. Output goes to
`compare.md` and `compare.json` in the second run's directory.

The baseline is normally a `passthrough` run of the same workload against the same
tenant state. Both runs must come from the same checkout; if they share no identity
at all, the comparison is reported as suspicious rather than as total loss.

## Recommended workflow

1. **Baseline.** Run the workload once with `--profile passthrough`. It still writes
   a full journal and report.
2. **Faulted run.** Pick a profile for the question, pass `--seed`, and pass
   `--verify-cmd` so verdict 8 has evidence. Note the run directory.
3. **Compare.** `compare <baseline> <faulted>` finds what was lost.
4. **Fix.** Read the verdicts that did not pass and the matching report sections.
5. **Replay.** `run --replay <faulted>` reapplies the same faults to the same
   requests. Verdict 9 confirms the replay was faithful; the other verdicts and a
   fresh `compare` confirm the fix.

`--verify-cmd` runs after the command exits, through the shell, **without** the
preload, against the real service. Use a script that runs Atlas's verification on
the snapshot the run just wrote. `atlas outlook verify` checks that what was stored
is intact; it cannot know that a listing ended early, so pair it with `compare`.

## Options

| Flag                               | Effect                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--profile <id>`                   | Fault profile. Default `flaky`                                                                                   |
| `--profile-file <json>`            | Custom profile, same shape as the built-ins. Not with `--profile`                                                |
| `--seed <n\|string>`               | Seed, 1 to 64 letters, digits, `.`, `_`, or `-`. Default random; always printed and recorded                     |
| `--intensity <x>`                  | Multiply every rate, 0 to 100. Default 1. Total clamped to 95 %                                                  |
| `--outage <svc:start:dur[:fault]>` | Timed outage of one service. Repeatable                                                                          |
| `--service <svc>`                  | Service for the `outage` profile's window. Only with `--profile outage`                                          |
| `--services <a,b>`                 | Random faults only for these services. Outages unaffected                                                        |
| `--faults <a,b>`                   | Keep only these fault ids from the profile                                                                       |
| `--exclude-faults <a,b>`           | Remove these fault ids from the profile                                                                          |
| `--upstream <url>`                 | Forward every request to this base URL instead of the real hosts. For testing; https, or http to loopback only   |
| `--max-hold <dur>`                 | Cap for any single injected wait. Default `120s`                                                                 |
| `--out <dir>`                      | Run directory. Must not already hold a journal. Default `<repo>/.outagesoft-365/<UTC timestamp>/`                |
| `--replay <run-dir>`               | Apply exactly the faults that run applied. Takes profile, seed, and filters from it                              |
| `--verify-cmd "<command>"`         | After the command exits, run this without the relay and record its exit code. Skipped if the run was interrupted |
| `--quiet`                          | No per-request lines on stderr                                                                                   |

`--faults` and `--exclude-faults` filter the profile's rates; they do not add
faults the profile lacks. To inject a fault the profile does not have, use a
profile file. Invalid input (an unknown profile, fault, or service, a bad duration,
a missing command) fails before anything starts, with the bad value named.

Without `--quiet`, each finished exchange prints one line:

```text
[outagesoft-365] throttle_429 429 GET graph.microsoft.com/v1.0/users/{upn}/messages/{id}/$value 0ms
[outagesoft-365] slow_first_byte 200 GET graph.microsoft.com/v1.0/users/{upn}/messages/{id}/$value 11234ms
[outagesoft-365] lost_response reset POST graph.microsoft.com/v1.0/users/{upn}/messages 2ms
```

| Exit code     | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| the command's | `run` passes the command's own exit code through unchanged    |
| 128 + signal  | The command was killed by a signal (143 for SIGTERM)          |
| 127           | The command could not be started                              |
| 64            | The tool rejected its own usage or input; nothing was started |
| 70            | The tool failed internally                                    |

64 and 70 are the sysexits values, chosen so they cannot be mistaken for Atlas's
own exit code 2 for a partial failure.

SIGTERM and SIGHUP are forwarded to the command. SIGINT is forwarded only when
stdin is not a terminal: a Ctrl-C at a terminal already reaches the command,
because it shares the foreground process group, and a second copy would turn
Atlas's graceful first interrupt into a forced abort. Any of the three marks the
run as interrupted, and `--verify-cmd` is then skipped. The journal and report are
written either way.

`OUTAGESOFT_TEST_FORCE=1` makes the relay honour an `x-outagesoft-force: <fault id>`
request header. It exists for the selfcheck. Never set it otherwise.

## Run directory

| File                         | Contents                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.json`                   | Settings, effective rates, seed, outages, executable name and argument count, child and verify exit codes, relay counters, replay divergence                             |
| `journal.jsonl`              | One line per exchange: redacted URL, keyed identity, service, kind, fault and parameters, upstream and delivered status, outcome, timings, byte counts, Graph error code |
| `report.md`, `report.json`   | The report                                                                                                                                                               |
| `compare.md`, `compare.json` | Written into the second run's directory by `compare`                                                                                                                     |

`.outagesoft-365/identity.key` sits beside the run directories, not inside them.

Journal fields:

| Field                        | Meaning                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`, `t`                   | Arrival order, and milliseconds since the relay started                                                                                            |
| `method`, `url`              | Method and redacted URL                                                                                                                            |
| `url_key`                    | Keyed digest of method and raw URL: the exact request, token included                                                                              |
| `base_key`                   | Keyed digest of the base identity, shared by every page of one listing                                                                             |
| `identity_key`, `occurrence` | Keyed digest of the full identity, and which arrival of it this was (1 for the first, 2 for a retry)                                               |
| `page`                       | Page ordinal within a listing, or `null` for a request without a delta or skip token                                                               |
| `service`, `kind`, `cursor`  | Classification, and `delta`, `skip`, or `null`                                                                                                     |
| `idempotent`                 | `false` for POST, and PATCH without If-Match; token requests count as idempotent                                                                   |
| `req_bytes`, `body_key`      | Request body size and keyed digest; no digest for GET or token requests                                                                            |
| `fault`                      | `id`, `category`, `source` (`profile`, `outage`, or `replay`), drawn `params`, and `skipped` with a reason                                         |
| `forwarded`, `upstream`      | Whether the request reached the upstream; its status, timings, bytes, and transport error                                                          |
| `delivered`                  | What the client got: status, `outcome` (`complete`, `reset`, `truncated`, `no_response`, `client_closed`, `relay_error`), bytes, time, Retry-After |
| `graph_error`                | The Graph error code delivered, synthetic or real                                                                                                  |

The journal is for grepping, not reading whole. A run of a few thousand requests
is a few thousand lines; `report` is the aggregate.

```bash
grep '"id":"lost_response"' .outagesoft-365/lossy/journal.jsonl
```

## Security

The relay sits in the path of authenticated traffic, so what it holds and what it
writes are deliberately separate.

**In memory only.** Bearer tokens, client secrets in token requests, and request
and response bodies (mail and file content) stream through the relay process. They
are never written anywhere. Bodies are piped, not buffered, with two exceptions
held in memory: a JSON write body of up to 1 MiB, read for its identity digest,
and a JSON response of up to 4 MiB, held for a content fault.

**Never written.** No header, no body, no raw URL, and no argument of the command.
`run.json` records only the executable's name and the argument count, because
arguments name mailboxes. Journal lines are built from an explicit field allowlist,
and URLs pass through the redaction shared with graph-tap
(`tools/graph-tap/redact.mjs`):

| In the URL                                                                | Becomes                                      |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| GUIDs, mail addresses                                                     | `{guid}`, `{upn}`                            |
| The segment after `users/`, `messages/`, `drives/`, `items/`, and similar | `{id}` (or `{upn}`), whatever its shape      |
| Path-addressed file and folder names (`root:/Finance/Q1 budget.xlsx:`)    | `root:/{path}:`                              |
| SharePoint host label, site, personal site owner                          | `{tenant}.sharepoint.com`, `{site}`, `{upn}` |
| Tenant segment of a token URL                                             | `{tenant}`                                   |
| Quoted literals in query values (`$filter=subject eq 'Board minutes'`)    | `'{value}'`                                  |
| Delta and skip tokens, `tempauth`, SAS signatures, secrets                | their byte count, e.g. `<1840b>`             |

**Keyed digests.** `identity_key`, `url_key`, and the request body digest are the
first 16 hex characters of HMAC-SHA256 under `.outagesoft-365/identity.key`: 32
random bytes, created on first use with mode 0600, never copied into a run
directory. With the key, a digest can be tested against a guessed URL or mailbox
address. Without it, digests are meaningless. Do not share the key.

**Loopback and a per-run token.** The relay listens on `127.0.0.1` on an ephemeral
port. Every request must carry the run's random 24-byte token as its first path
segment, compared in constant time. Anything else gets 404 and is not forwarded. A
token-bearing request for a host outside the allowlist gets 403, so the relay
cannot be used to reach an arbitrary host. The token lives in the command's
environment for the length of the run.

**`--upstream` receives credentials.** It forwards everything, bearer tokens and
token request bodies included, to the given base URL. It accepts https, or plain
http only to a loopback host, and refuses a URL with credentials in it. Point it
only at a local fake you control.

**Run directories still describe a tenant.** The value of a query parameter the
redaction does not know is kept as sent unless it is quoted, a GUID, or a mail
address: `customParam=BoardMinutes` stays verbatim. Status codes, timings, and
request shapes also describe the workload. Directories are created 0700 and files 0600. Keep `.outagesoft-365/`
local; it is gitignored. The run's opening lines print the absolute run directory,
which carries a username. Sanitise anything from a run before it goes into an issue,
following the repository's public-data rules.

## Limitations

- **Platform.** Tested on Linux (Ubuntu 22.04 under WSL) with Node 22.22.3 and
  24.11.0. The wrapper is a bash script and needs Node 22.22.2 or later, which
  `doctor` checks. macOS and native Windows are untested.
- **Node only.** Interception is a Node preload. A process that is not Node is not
  intercepted, and there is no generic TCP tunnel mode for one.
- **Two transports.** Graph traffic is re-routed when it uses global `fetch`;
  `node:https` is re-routed only for `login.microsoftonline.com`. Other HTTP clients
  go direct. Only the public cloud hosts listed above are covered.
- **Does not stack with graph-tap.** graph-tap observes undici below the re-route,
  where every request is addressed to the loopback relay, so wrapped around
  outagesoft-365 it records 0 requests. Use the report's "Compare with real
  behaviour" block instead.
- **`$batch` is always `directory`.** The relay does not interpret which workloads
  a batch addresses, so service filters and outage windows cannot target batched
  mailbox calls. `--services outlook` does not fault batches, and an `outlook`
  outage lets them through.
- **Batch inner 429s are not advised waits.** `batch_inner_429` carries Retry-After
  inside an outer 200, so verdict 1 does not judge it.
- **Outage windows are time-based.** Which requests a window hits depends on
  timing. Use `--replay` for exactness.
- **Ordinals follow first arrival.** Page and upload-session ordinals assume pages
  and fragments arrive in the same order in every run. A client that changes that
  order changes which request a replayed fault lands on.
- **Large write bodies are identified by URL.** A JSON body over 1 MiB, a chunked
  one, or a non-JSON one is not digested into the identity, so two such writes to
  one URL share an identity and are told apart only by occurrence.
- **SIGINT at a terminal is not forwarded** (see [Options](#options)); the command
  receives the Ctrl-C directly. From a script with no terminal, the tool forwards it.
- **Mutations have limits.** Content faults and `out_of_order` skip non-JSON
  responses and bodies over 4 MiB; `truncated_body` skips bodies too short to cut.
- **Verdicts are inferences** from relayed traffic, not observations of the client.

## Files

Paths are relative to `tools/outagesoft-365/`.

| Path                                      | Purpose                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `outagesoft-365`                          | Shell entry point                                                                                                        |
| `src/cli.mjs`                             | Command dispatch: `run`, `report`, `compare`, `profiles`, `faults`, `doctor`, `selfcheck`                                |
| `src/cli/`                                | Argument parsing, the `profiles` and `faults` tables, and `doctor`                                                       |
| `src/run/`                                | One run: the plan, the run directory, the child process, and the identity key                                            |
| `src/preload/`                            | The `fetch` and `node:https` re-routes loaded into the child                                                             |
| `src/relay/`                              | The relay: token check, fault execution, upstream forwarding, and the journal                                            |
| `src/request/`                            | Host allowlist, service classification, relay routing, and request identity keys                                         |
| `src/planning/`                           | Profiles, outage windows, the seeded fault decision, and replay                                                          |
| `src/faults/`                             | Fault catalog and the wire shape of each fault                                                                           |
| `src/report/`                             | `report` and `compare`: `journal/` reads a run, `analysis/` builds the model, `verdicts/` judges it, `render/` prints it |
| `src/selfcheck/`, `src/report/selfcheck/` | End-to-end check against a local fake Graph, and the report checks                                                       |
| `src/shared/`                             | Duration parsing and tool errors                                                                                         |
| `tools/graph-tap/redact.mjs`              | URL redaction shared with graph-tap (repository path)                                                                    |

## Verify after changing the tool

```bash
./tools/outagesoft-365/outagesoft-365 selfcheck
./tools/graph-tap/graph-tap selfcheck     # after touching tools/graph-tap/redact.mjs
```

The selfcheck needs no network or credentials and finishes in seconds. It drives
the real `run` path against a local fake Graph through `--upstream` and asserts
that traffic is re-routed with `response.url` unchanged, that no bearer token or
body content reaches any output, that a wrong relay token is refused, that
synthetic faults carry Graph's wire shape and the transport and content faults do
what they claim, that outage windows stay inside their service and time, that a
seed and a replay reproduce the same faults, and that the report and verdicts
detect what they claim to.

## Related

- [Graph request tracing](/development/graph-tap) records real traffic; this page
  simulates bad traffic
- [Graph API Rate Limits](/operations/graph-rate-limits) explains the throttling
  Atlas is expected to survive
- [Delta Sync](/operations/delta-sync) explains the checkpoints verdict 5 judges
