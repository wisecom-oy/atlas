# SDK Progress and Cancellation Design

## Goal

Issue #39 adds typed progress callbacks and graceful `AbortSignal` cancellation to long-running SDK backup, restore, save, and verify operations for Outlook, OneDrive, and SharePoint.

A cancelled operation returns its normal partial result with `interrupted: true`. It does not reject with `AbortError`, and it does not force-cancel an in-flight Graph or S3 request.

## Public API

SDK methods accept additive camelCase options:

```ts
await atlas.outlook.backup('user@example.com', {
  onProgress: (event) => render_progress(event),
  signal: abort_controller.signal,
});
```

The SDK owns these public option wrappers rather than exposing internal snake_case service options or CLI reporter interfaces.

`ProgressEvent` is a discriminated union with these common fields:

- `operation`: `backup | restore | save | verify`
- `workload`: `outlook | onedrive | sharepoint`
- `phase`: `discovering | processing | finalizing | completed | interrupted`
- `processed`: completed work units
- `total`: known work units, or `undefined` before discovery completes
- `current`: optional folder, file, drive, library, or snapshot label
- `rate`: optional work units per second

Operation-specific event members may narrow `current`, but consumers can render a useful progress bar from the common fields alone.

All affected results expose `interrupted: boolean`. Existing fields and method signatures remain compatible.

## Adapter Boundary

SDK namespace factories translate public options into existing internal hooks:

- `signal.aborted` becomes an interruption predicate.
- `onProgress` receives events emitted at service safe points.
- Existing CLI `BackupProgressReporter` and `TransferProgressReporter` adapters remain valid.

The CLI does not need to adopt the SDK wrapper types. Public SDK naming remains camelCase; internal ports retain repository conventions.

## Cancellation Semantics

Cancellation is cooperative and checked between durable work units:

- Outlook backup: between folders/pages/messages using the existing safe interruption hooks.
- OneDrive backup: between drives and items.
- SharePoint backup: between sites, libraries, and items.
- Restore/save/verify: between messages, files, folders, manifests, or verification entries.

An already-started Graph or S3 request finishes normally. The next safe-point check stops further work and emits one terminal `interrupted` event.

A pre-aborted signal returns an interrupted zero-work result without beginning remote enumeration.

## Delta Safety

Outlook keeps the safe delta behavior implemented for issue #23.

OneDrive and SharePoint must not persist a newly fetched delta link when cancellation leaves a drive or library partially processed. The previous persisted cursor remains authoritative. The next run re-enumerates those changes and content-addressed storage deduplicates completed objects.

Completed drives or libraries may persist their cursor before cancellation is observed in a later unit.

## Progress Ordering

Each operation emits monotonic lifecycle events:

1. `discovering`
2. zero or more `processing`
3. `finalizing` when durable result assembly begins
4. exactly one terminal event: `completed` or `interrupted`

`processed` never decreases within one operation. `total` may be absent during discovery, then becomes stable once known. Callback exceptions are isolated from the operation and do not fail backup or restore work.

## Error Handling

Cancellation and operational failure remain distinct:

- Cancellation returns partial counts with `interrupted: true`.
- Item-level failures continue through existing error accounting.
- Fatal Graph, storage, crypto, or validation errors still reject.
- Callback exceptions are ignored after optional debug logging.

## Tests

Focused contract tests cover:

- typed SDK options and camelCase-to-internal adaptation;
- lifecycle event order and monotonic counts;
- pre-aborted and mid-operation signals;
- graceful partial results for backup, restore, save, and verify;
- Outlook, OneDrive, and SharePoint backup cursor preservation on partial work;
- unchanged CLI reporter behavior.

Full E2E validation uses the current Wisecom tenant and configured MinIO storage:

1. Start an Outlook backup and abort from a progress callback.
2. Assert `interrupted: true` and a terminal `interrupted` event.
3. Rerun to completion and verify no delta/content loss.
4. Exercise OneDrive and SharePoint progress callbacks and cancellation at safe points.
5. Exercise restore/save/verify callbacks where tenant data permits.
6. Remove every created tenant and storage artifact, including object versions and delete markers, and restore MinIO to its prior running state.

## Documentation

`docs/reference/sdk.md` documents:

- option signatures for all three namespaces;
- the `ProgressEvent` fields and phase ordering;
- graceful cancellation and partial-result semantics;
- an `AbortController` example;
- the guarantee that cancellation waits for the current remote request to finish.
