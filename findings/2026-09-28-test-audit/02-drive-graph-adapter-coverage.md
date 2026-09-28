# Drive Graph adapters are thinly tested where restore and delta behaviour lives: SharePoint restore adapter at 0%, fetch_delta reset untested in both connectors

**Triage:** RECORD (high confidence, `test`, `priority: medium`)

## Atlas version

5.2.2 (`main`, commit `4d6ee39`)

## Description

Services in both drive packages are well covered (merged line coverage: `drive` 91%, `onedrive`
86%, `sharepoint` 80%). The Graph adapters under them are not, and the services mock those
adapters, so the code that talks to Graph during restore and delta sync runs in no unit test. It
runs only in the nightly E2E suite, which uses a live tenant and small fixtures.

Coverage below is merged across every package's test run, so a file exercised from another
package counts as covered.

| File                                                            | Lines       | Branches | What is untested                                                                                                         |
| --------------------------------------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `sharepoint/src/adapters/graph-sharepoint-restore.adapter.ts`   | 0% of 38    | 0%       | Everything: folder create, the `409` conflict fallback, small upload, `fileSystemInfo` stamping, upload session creation |
| `onedrive/src/adapters/graph-onedrive-restore.adapter.ts`       | 48.7% of 39 | 42.9%    | The `409` conflict fallback (lines 39-67) and the missing-`uploadUrl` guard                                              |
| `onedrive/src/adapters/graph-onedrive-connector.adapter.ts`     | 31.8% of 66 | 16.7%    | `fetch_delta`: the invalid-token reset (94-101) and paging (277-303)                                                     |
| `sharepoint/src/adapters/graph-sharepoint-connector.adapter.ts` | 6.8% of 73  | 0%       | The same in the twin (165-172, 303-329), plus `resolve_site`                                                             |
| `sharepoint/src/adapters/graph-sharepoint-delta-fetch.ts`       | 6.3% of 16  | 0%       | The stale-cursor check that forces a fresh delta                                                                         |
| `sharepoint/src/adapters/graph-sharepoint-url-parser.ts`        | 0% of 7     | 0%       | Turning the operator's `--site` value into a Graph site reference                                                        |
| `drive/src/restore/upload-session.ts`                           | 68.1% of 69 | 56.5%    | The guard for a source shorter than the manifest (165), chunk retry on `5xx` and `Retry-After` (199-210)                 |

Why these matter:

- **The `409` path is the normal restore case.** Restoring into a tree that already has the
  folder answers `409`, and the adapter must find the existing folder by name and reuse it. A
  regression there fails or duplicates every folder of a restore. Neither twin tests it.
- **`fetch_delta` decides whether tracking state is cleared.** On an invalid delta token it
  re-enumerates and sets `reset_detected`, which `clear_file_tracking_on_reset` depends on
  (#199). The token check itself matches on message substrings (`is_invalid_delta_error`), so a
  Graph wording change would pass unnoticed.
- **The shorter-source guard is the other half of an integrity check.** `upload-session.ts:148`
  refuses a source longer than the manifest and is tested. `:165` refuses one that is shorter,
  which is how a truncated restore would present, and is not.

## Acceptance criteria

- A test file for `graph-sharepoint-restore.adapter.ts` covering folder create, the `409`
  fallback (found and not found), small upload with `fileSystemInfo`, and a missing `uploadUrl`.
- The `409` fallback tested in the OneDrive twin as well.
- `fetch_delta` tested in both connectors: normal paging to a `@odata.deltaLink`, an
  invalid-token error that re-enumerates with `reset_detected: true`, a stale cursor, and a
  `403` that surfaces as the permission error.
- `graph-sharepoint-url-parser.ts` tested for a full URL, a `hostname:/path` reference and a
  bare site id.
- `upload-session.ts` tested for a source shorter than `total_bytes`, and for a transient `5xx`
  chunk that succeeds on retry with and without `Retry-After`.
- Tests mock the Graph client or `fetch`, not the adapter under test.

Found during a test audit (`findings/2026-09-28-test-audit/02-*.md` on `claude/quirky-newton-8xf6eb`).
Same shape as #191 through #194, whose adapters are now covered.
