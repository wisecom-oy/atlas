# Error path audit, 2026-09-28

Audit of error handling against the contract in `docs/reference/sdk.md#errors` and
`docs/reference/cli.md#exit-codes` at commit `4d6ee39` (v5.2.2). The contract: every failure
Atlas raises on purpose is an `AtlasError` with a stable `code`, and the CLI maps that code, or
an HTTP status found on the `cause` chain, to exit codes `3` through `9`. A plain `Error` with
neither exits `1`.

Method: every `throw new Error(` in `packages/*/src` (121 sites in 58 files), every `catch` that
returns a value instead of rethrowing, every catch that rethrows a new error, and the CLI and SDK
boundaries (`packages/cli/src/fatal-error.ts`, `packages/sdk/src`).

| #         | Finding                                                                                                         | Priority | Labels |
| --------- | --------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| 01 (#437) | [Deliberate not-found failures are raised as plain `Error`](01-not-found-raised-as-plain-error.md)              | medium   | `bug`  |
| 02 (#438) | [Drive cursors and the identity registry swallow read failures](02-state-repositories-swallow-read-failures.md) | medium   | `bug`  |
| 03 (#439) | [Verify reports storage failures as corrupt objects](03-verify-reports-storage-failures-as-corruption.md)       | medium   | `bug`  |
| 04 (#440) | [`ThrottledError` is documented but never raised](04-throttled-error-never-raised.md)                           | low      | `bug`  |

Added as evidence to an existing issue rather than filed: `CachingIdentityResolver` creates a
tenant context in `ensure_loaded` and `persist` and never destroys either, which is the class
#436 covers.

Checked and dropped:

- CLI usage and flag validation errors throw plain `Error` and exit `1`. The exit code table
  documents `1` for invalid command usage.
- CLI configuration loading wraps every failure in `ConfigError` (`packages/cli/src/container.ts:23`).
- Raw Graph and S3 errors carry `statusCode` or `$metadata.httpStatusCode`, which
  `fatal-error.ts` maps to `4`, `7` and `3` without an `AtlasError` wrapper.
- Per-item integrity failures (checksum mismatch, truncated stream, failed chunk) are caught per
  item and reported as partial (`2`), which the contract allows.
- Deletion blocked by Object Lock exits non-zero, as `docs/operations/immutability.md` states.
- The Outlook delta cursor also swallows read failures, but falls back to the manifest links on
  purpose and says so in a comment (`s3-mailbox-delta-cursor-repository.adapter.ts:33`).
- Every CLI action is reached through `program.parseAsync(...).catch(handle_fatal_error)`
  (`packages/cli/src/cli.ts:59`).
