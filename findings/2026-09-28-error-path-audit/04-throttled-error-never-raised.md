# ThrottledError is documented and exported but never raised, and the docs name its field retryAfterMs while the class has retry_after_ms

**Triage:** RECORD (high confidence, `bug`, `priority: low`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

`docs/reference/sdk.md#errors` lists `ThrottledError` (`ATLAS_THROTTLED`): "Service throttled the
call and the retry budget was spent; see `retryAfterMs`". The SDK exports the class.

Nothing constructs it. When `with_graph_retry` exhausts its 12 retries on a `429`, it rethrows
the raw Graph SDK error. An SDK caller that branches on `instanceof ThrottledError`, or on
`code === 'ATLAS_THROTTLED'`, never matches.

The field the docs name does not exist either. The class declares `retry_after_ms`, and the SDK
does not translate errors to camelCase the way it does results.

The CLI is not affected: `fatal-error.ts` reads `statusCode: 429` off the raw error and exits `3`.

## Steps to reproduce

1. Run an SDK backup against a tenant that returns `429` for longer than the retry budget
   (about 23 minutes), or stub the Graph client to always return `429`.
2. Catch the rejection and test `err instanceof ThrottledError`.

## Expected

`true`, with `retryAfterMs` (or whatever field the docs settle on) set from the last
`Retry-After`.

## Actual

`false`. The error is the Graph SDK's own, with `statusCode: 429`.

## Code references

- `packages/types/src/errors/atlas-errors.ts:56` defines the class with `retry_after_ms`.
- `packages/sdk/src/index.ts:105` exports it.
- `packages/m365-graph/src/graph-request-error-handler.ts:121` rethrows the raw error when the
  budget is spent.
- `packages/sharepoint/src/adapters/graph-sharepoint-download-executor.ts:217` ends the same way
  with a plain `Error('download_from_url: exhausted retries ...')`, which also drops the status.
- `docs/reference/sdk.md:999` documents `retryAfterMs`.

## Interface

SDK.

## Environment

```
OS: Ubuntu 24.04.4 LTS
Kernel: 6.18.44-fc-v42
Arch: x86_64
Node: v22.22.2
pnpm: 10.30.3
Atlas: 5.2.2
Git commit: 4d6ee39 (clean)
```

## Acceptance criteria

- `with_graph_retry` raises `ThrottledError` with the original error as `cause` when its budget
  ends on a `429`. Other exhausted statuses keep their current behaviour.
- The retry-after field name in the docs and the class agree.
- The CLI still exits `3` for an exhausted throttle.
- A unit test drives `with_graph_retry` to exhaustion on `429` and asserts the class, code, field
  and cause.
