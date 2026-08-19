# Graph Request Tracing

`graph-tap` records every HTTP request Atlas sends to Microsoft Graph and collapses
the result into a report you can read in one screen. The interesting questions about
a backup are questions about the wire: why a run is throttled, why one mailbox
fails, how many Graph calls a single message really costs. Atlas's own logs describe
intent rather than traffic.

This is a development tool. It is not shipped to end users, is not part of the
`atlas` CLI, and is excluded from the published package.

## Quick Start

```bash
# 1. Always check prerequisites first. Default capture needs nothing but Node.
./tools/graph-tap/graph-tap doctor

# 2. Wrap any command that talks to Graph.
./tools/graph-tap/graph-tap run -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com

# 3. Read the aggregate, not the raw capture.
./tools/graph-tap/graph-tap summary
```

Captures are written as JSON Lines to `.graph-tap/` (gitignored). `run` passes the
wrapped command's exit code through, so a failing run still leaves a valid capture.

## Platform Support

| Platform | Supported | Notes                                         |
| -------- | --------- | --------------------------------------------- |
| macOS    | Yes       | bash 3.2 compatible; `mitmproxy` via Homebrew |
| Linux    | Yes       | `mitmproxy` via `pipx` or the distro package  |
| Windows  | **No**    | The wrapper is a POSIX shell script           |

Windows is deliberately out of scope. The capture engine itself (`tap.mjs`) is
plain Node and platform-neutral, so a Windows user can invoke it directly and lose
only the wrapper and proxy mode:

```powershell
$env:GRAPH_TAP_OUT = "capture.jsonl"
$env:NODE_OPTIONS  = '--import="C:\path\to\tools\graph-tap\tap.mjs"'
node packages\cli\dist\cli.mjs outlook backup -m user@example.com
$env:GRAPH_TAP_FILE = "capture.jsonl"; node tools\graph-tap\summary.mjs
```

WSL is the better answer if you want the wrapper.

## How Interception Works

Atlas reaches Graph through exactly one transport: the global `fetch` function.
The Graph SDK's `HTTPMessageHandler` calls `fetch(context.request, context.options)`
directly, and the OneDrive and SharePoint chunked download and upload paths call
`fetch` themselves for pre-authenticated URLs. In Node, global `fetch` is undici,
and undici publishes its full request lifecycle on
[`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html).

`graph-tap` subscribes to those channels from a `--import` preload. This is why the
tap sits there rather than behind a proxy:

- **No proxy, no certificate, no privileges.** Nothing is re-routed and TLS is not
  terminated, so the traffic you observe is the traffic Atlas actually sent.
- **Nothing can be missed by sitting at the wrong layer.** The tap is below the
  SDK's retry and redirect handlers, so every retry and every followed redirect is
  a separate recorded request, the same position the cost middleware occupies.
- **No effect on the observed process.** Every subscriber is wrapped in a `try`
  block; a bug in the tap cannot break a backup.
- **No dependency.** `node:diagnostics_channel` and `node:zlib` are standard
  library.

The undici channels used are `undici:request:create`, `:bodyChunkSent`,
`:headers`, `:bodyChunkReceived`, `:trailers`, and `:error`.

### Version Requirements

| Capability                                   | Requirement                       | If unmet                                    |
| -------------------------------------------- | --------------------------------- | ------------------------------------------- |
| URL, status, timing, throttling, error codes | Node >= 22                        | n/a                                         |
| Byte counts and `--bodies`                   | Node >= 24 (undici >= 7.11)       | Byte fields read `0`; everything else works |
| `proxy` mode                                 | Node >= 24 (`NODE_USE_ENV_PROXY`) | Use default capture                         |

`graph-tap doctor` reports each of these against your installed runtime, so you
never have to guess whether a `0` means "no bytes" or "not measurable".

## Output Is Sized For Analysis

The capture is written to be read by a person or an LLM, not to be complete. A
single-mailbox backup of 4000 messages produces roughly 5.5 MB of raw request and
response metadata; `graph-tap` records 477 KB of it and summarises to under 1 KB.

Three decisions do the work:

**Identifiers are templated.** Path segments that are GUIDs, UPNs, or long opaque
item IDs become `{guid}`, `{upn}`, `{id}`. Four thousand per-message fetches
therefore aggregate into one row instead of four thousand near-identical lines.

**Opaque values are reduced to their size.** Delta and skip tokens run to
kilobytes of base64 that no analysis reads, so `$deltatoken=<1840b>` is recorded
instead. The same applies to download-URL credentials.

**Headers are an allowlist, not a denylist.** Only throttling and shape headers
are kept: `retry-after`, `ratelimit-*`, `x-ms-throttle-*`, `x-ms-resource-unit`,
`location`, and non-JSON `content-type`. Server trace IDs, `x-ms-ags-diagnostic`
payloads, HSTS, and CORS noise are discarded.

Graph error codes are the exception to the trimming: they are extracted from every
non-2xx response and always recorded, because a code such as
`activityLimitReached` or `ErrorItemNotFound` is usually the entire answer. Graph
gzips these payloads, so the tap inflates them with `node:zlib` before parsing;
truncated bodies are decoded with `Z_SYNC_FLUSH` rather than discarded.

### Reading a Summary

```
GRAPH TAP SUMMARY  .graph-tap/2026-08-18T07-14-22Z.jsonl
4072 requests over 72.6s · tx 0B · rx 21MB
status: 200×3960 429×100 404×12

REQUEST SHAPES (3)
 4000  GET    graph.microsoft.com/v1.0/users/{upn}/messages/{id}
         200×3900 429×100 · p50 26ms p95 40ms max 41ms · rx 16MB
   60  GET    graph.microsoft.com/v1.0/users/{upn}/mailFolders/{id}/messages/delta?$deltatoken=<1840b>&$select=id,subject,receivedDateTime
         200×60 · p50 380ms p95 380ms max 380ms · rx 5.0MB

THROTTLING
  100  GET graph.microsoft.com/v1.0/users/{upn}/messages/{id}
         retry-after 12s (max 12s) · scope Mail.Read

ERRORS
   12  404 ErrorItemNotFound -- The specified object was not found in the store.
         on graph.microsoft.com/v1.0/users/{upn}/messages/{id}/attachments
```

`THROTTLING` covers 429 and 503 with their `retry-after` values and throttle
scope; those statuses are excluded from `ERRORS` so they are not counted twice.
`SLOWEST` appears only when a request exceeded one second. Open the raw `.jsonl`
only when one specific request matters.

## Options

| Flag              | Effect                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `--headers`       | keep an allowlist of request headers (`content-type`, `content-range`, `range`, `prefer`, `if-match`) |
| `--bodies`        | record request bodies, capped at 2048 bytes                                                           |
| `--limit <bytes>` | change the `--bodies` cap                                                                             |
| `--all`           | record every host, not only Microsoft 365 endpoints                                                   |
| `--out <file>`    | write to a fixed path, for before/after comparison                                                    |

Environment equivalents, for invoking `tap.mjs` without the wrapper:
`GRAPH_TAP_OUT`, `GRAPH_TAP_HEADERS`, `GRAPH_TAP_BODIES`, `GRAPH_TAP_BODY_LIMIT`,
`GRAPH_TAP_ALL`, `GRAPH_TAP_HOSTS`, `GRAPH_TAP_QUIET`, `GRAPH_TAP_DIR`.

## What Captures Contain, And Why

A capture is a security artifact: it describes authenticated traffic to a tenant's
mail and files, and in practice it gets attached to issues and pasted into chat.
The redaction is therefore not configurable.

| Data                                                                        | Treatment                    | Reason                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`, `Cookie`, `Proxy-Authorization`                            | never recorded               | A Graph bearer token stays valid for roughly an hour. Anyone holding the capture could replay it against the tenant.         |
| `tempauth`, `guestaccesstoken`, `access_token`, `sig`, SAS-style parameters | replaced with byte count     | These are bearer credentials in a query string. `tempauth` on a OneDrive download URL grants access to that file on its own. |
| `$deltatoken`, `$skiptoken`                                                 | replaced with byte count     | Not secret, just kilobytes of noise.                                                                                         |
| Response bodies                                                             | byte count only              | Message bodies and file contents are personal data, and a 512 MiB download must never reach a log.                           |
| Error response bodies                                                       | recorded, capped at 2 KB     | The Graph error code is the diagnostic. Error payloads describe the failure, not the mailbox contents.                       |
| Request bodies                                                              | only with `--bodies`, capped | Restore and upload requests carry the customer's own mail and file data.                                                     |

What remains is still sensitive: URLs contain mailbox UPNs, site paths, and drive
IDs. Treat `.graph-tap/` as a log containing personal data. It is gitignored, and it
should not be committed or shared outside the tenant's own operators.

## Full TLS Inspection With mitmproxy

The default capture cannot show you raw TLS, let you rewrite a request, or observe
a process that is not Node. When you need that, `graph-tap proxy` starts
[mitmproxy](https://mitmproxy.org/) restricted to Microsoft 365 hosts:

```bash
./tools/graph-tap/graph-tap proxy        # default port 8080
```

It prints the environment to export in a second shell:

```bash
export HTTPS_PROXY=http://127.0.0.1:8080
export NODE_USE_ENV_PROXY=1
export NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
```

All three matter. `NODE_USE_ENV_PROXY=1` is mandatory and easy to miss: Node's
`fetch` is undici, and **undici ignores `HTTPS_PROXY` unless this variable is
set**. Without it your traffic silently bypasses the proxy and you conclude nothing
was sent. It was added in Node 24; on Node 22 there is no built-in equivalent, so
use the default capture instead.

`NODE_EXTRA_CA_CERTS` is what makes Node trust mitmproxy's generated CA.
mitmproxy writes that certificate on first launch, so the very first run may need
to be started twice. Do not reach for `NODE_TLS_REJECT_UNAUTHORIZED=0` instead:
`create_graph_client` refuses to start when certificate validation is disabled, by
design.

If mitmproxy is not installed, the command exits with install instructions rather
than failing obscurely:

```bash
brew install mitmproxy      # macOS
pipx install mitmproxy      # Linux
```

Understand the trade before choosing this path. Proxy mode requires an install, a
trusted CA certificate, Node >= 24, and it terminates TLS, so you inspect
mitmproxy's connection rather than Atlas's. The default capture needs none of that
and observes the real one.

## Files

| Path                            | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `tools/graph-tap/graph-tap`     | Shell entry point: `doctor`, `run`, `summary`, `proxy`                 |
| `tools/graph-tap/tap.mjs`       | Capture engine; `diagnostics_channel` subscriber loaded via `--import` |
| `tools/graph-tap/summary.mjs`   | Aggregates a capture into the report above                             |
| `tools/graph-tap/selfcheck.mjs` | Assert-based regression check; no network or credentials needed        |

Run it after changing anything in `tools/graph-tap/`:

```bash
./tools/graph-tap/graph-tap selfcheck
```

It drives the real tap against a local HTTP server and asserts that a bearer
token never reaches a capture, that delta tokens and `tempauth` credentials are
elided, that IDs are templated, and that gzipped Graph errors still decode.

## Related

- [Graph API Rate Limits](/operations/graph-rate-limits) explains what the
  throttling section is telling you
- [Delta Sync](/operations/delta-sync) explains what the delta requests are doing
- [Performance Profiling](/development/performance-profiling) covers CPU time rather
  than network traffic
