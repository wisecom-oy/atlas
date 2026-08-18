---
name: graph-tap
description: >-
  Record and analyse the HTTP requests Atlas sends to Microsoft Graph. Use when
  investigating throttling (429), unexpected Graph errors, delta sync behaviour,
  request volume or Graph cost, redundant calls, or any "what is Atlas actually
  sending?" question.
when_to_use: >-
  The user asks what Atlas sends to Graph, why a run is throttled or slow, why a
  Graph call fails, how many Graph requests an operation makes, or asks to trace,
  intercept, capture, or monitor Graph/network traffic.
---

# Graph Tap

Records every request Atlas sends to Microsoft Graph, then collapses the capture
into a report small enough to reason about. A 4000-message backup summarises to
under 1 KB.

`tools/graph-tap/graph-tap` — macOS and Linux only. Windows is not supported; see
`docs/development/graph-tap.md` for the manual equivalent.

## Confirm prerequisites before running anything

**Always run `doctor` first and show the user the result.** Never assume a tool is
installed, and never install anything without asking.

```bash
./tools/graph-tap/graph-tap doctor
```

It reports what is present and what each missing piece costs you. Act on it:

| Doctor says                      | Do this                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node ... present`               | Proceed. Default capture needs nothing else.                                                                                                                                                                                                             |
| `node MISSING`                   | Stop. Ask the user to install Node >= 22; Atlas cannot run either.                                                                                                                                                                                       |
| `byte counts no` / `--bodies no` | Proceed without them. Node < 24 lacks undici >= 7.11, so byte counts read 0. URLs, status, timing, throttling, and Graph error codes still work. Tell the user which field is unavailable rather than reporting 0 bytes as fact.                         |
| `proxy mode no`                  | Do not offer `proxy`; it needs Node >= 24. Default capture is unaffected.                                                                                                                                                                                |
| `mitmproxy not installed`        | Expected and fine. Only `graph-tap proxy` needs it. **Ask before installing** — offer `brew install mitmproxy` (macOS) or `pipx install mitmproxy` (Linux) and let the user decide. Default capture requires no install at all, so reach for that first. |

## Capture a run

```bash
./tools/graph-tap/graph-tap run -- <any command that talks to Graph>
./tools/graph-tap/graph-tap summary          # newest capture
```

Examples:

```bash
./tools/graph-tap/graph-tap run -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com
./tools/graph-tap/graph-tap run -- pnpm --filter @wisecom/atlas-cli exec atlas stats
./tools/graph-tap/graph-tap run --out /tmp/before.jsonl -- <command>   # pin the file for A/B runs
```

`run` preserves the wrapped command's exit code, so a failing backup still yields
a usable capture. Captures land in `.graph-tap/` (gitignored).

## Read the summary, not the capture

Start with `summary`. It is the whole point of the tool: identifiers in paths are
templated (`{id}`, `{guid}`, `{upn}`), so thousands of per-message calls collapse
into one row with a status mix, `p50/p95/max` timings, and byte totals.

| Section          | Use it for                                                  |
| ---------------- | ----------------------------------------------------------- |
| header line      | total requests, wall-clock span, bytes sent/received        |
| `REQUEST SHAPES` | which call dominates, how many, how slow, N+1 patterns      |
| `THROTTLING`     | 429/503 counts with `retry-after` values and throttle scope |
| `ERRORS`         | Graph error codes and messages, plus transport failures     |
| `SLOWEST`        | only shown when something exceeded 1s                       |

Only open the raw `.jsonl` when a specific individual request matters. Grep it;
do not paste it wholesale into context.

## Options

| Flag              | Effect                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--headers`       | adds an allowlist of request headers (`content-type`, `content-range`, `range`, `prefer`, `if-match`)                        |
| `--bodies`        | records request bodies, capped at 2048 B. **Ask the user first**: restore and upload bodies contain their mail and file data |
| `--limit <bytes>` | changes the `--bodies` cap                                                                                                   |
| `--all`           | records every host, not just Microsoft 365. Use when you suspect traffic to somewhere unexpected                             |
| `--out <file>`    | fixes the capture path, for before/after comparison                                                                          |

You rarely need `--bodies`: Graph error codes and messages are extracted
automatically on every non-2xx response, gzip included.

## What is deliberately not recorded

Do not offer to "capture everything" — the omissions are the design:

- **`Authorization` and `Cookie` are never written.** A Graph bearer token is
  valid for about an hour; captures get pasted into issues.
- **Delta/skip tokens and download-URL credentials** (`tempauth`,
  `guestaccesstoken`) are reduced to a byte count, e.g. `$deltatoken=<1840b>`.
  They are kilobytes of opaque base64, and `tempauth` alone grants file access.
- **Response bodies are not stored**, only their byte count. A 512 MiB OneDrive
  download must never enter a log; error payloads are the exception, capped at
  2 KB, because the error code is the useful part.

Treat a capture as sensitive anyway: URLs contain mailbox UPNs and site paths.

## Full TLS view with mitmproxy

Only when the default capture is genuinely insufficient — you need to inspect
raw TLS, replay or modify requests, or watch a process that is not Node:

```bash
./tools/graph-tap/graph-tap proxy        # refuses with install instructions if absent
```

It prints the three variables to export in a second shell
(`HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS`) and starts
`mitmweb` restricted to Microsoft 365 hosts. `NODE_USE_ENV_PROXY=1` is required:
Node's `fetch` ignores `HTTPS_PROXY` without it.

Note the tradeoffs before suggesting this: it needs an install, a trusted CA
certificate, Node >= 24, and it terminates TLS. The default capture needs none of
that.

## If you change the tool

Run `./tools/graph-tap/graph-tap selfcheck` before reporting a change as working.
It needs no network or credentials, and it fails if redaction, token elision, ID
templating, or gzip error decoding breaks.

## How it works

`node --import` loads `tools/graph-tap/tap.mjs`, which subscribes to undici's
`node:diagnostics_channel` events. Every Graph call in Atlas goes through global
`fetch` — the Graph SDK's `HTTPMessageHandler` calls it directly, and the
OneDrive/SharePoint chunked transfer paths call it themselves — and global `fetch`
is undici. So this observes the real process with no proxy, no certificate, and
no privileges, and it cannot miss a call by sitting at the wrong layer.

Subscribers are wrapped so a bug in the tap can never break the run it observes.
