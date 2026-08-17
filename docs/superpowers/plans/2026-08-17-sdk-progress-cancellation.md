# SDK Progress and Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose typed progress events and graceful `AbortSignal` cancellation for Outlook, OneDrive, and SharePoint SDK backup, restore, save, and verify operations.

**Architecture:** Public camelCase SDK options are adapted at the SDK boundary to additive internal progress and interruption hooks. Workload services poll cancellation only between durable work units, return partial results with `interrupted: true`, and preserve the previous delta cursor whenever cancellation leaves a drive or library incomplete.

**Tech Stack:** TypeScript 5.9, Inversify ports/adapters, Vitest, pnpm/turbo, Microsoft Graph, MinIO/S3.

---

### Task 1: Public contracts and SDK option adaptation

**Files:**
- Create: `packages/types/src/ports/atlas/progress-event.port.ts`
- Modify: `packages/types/src/ports/index.ts`
- Modify: `packages/types/src/ports/atlas/outlook-api.port.ts`
- Modify: `packages/types/src/ports/atlas/onedrive-api.port.ts`
- Modify: `packages/types/src/ports/atlas/sharepoint-api.port.ts`
- Modify: operation option/result ports under `packages/types/src/ports/{backup,restore,save,verification,onedrive,sharepoint}/`
- Create: `packages/sdk/src/operation-options.ts`
- Modify: `packages/sdk/src/outlook-api.factory.ts`
- Modify: `packages/sdk/src/onedrive-api.factory.ts`
- Modify: `packages/sdk/src/sharepoint-api.factory.ts`
- Create: `packages/sdk/tests/unit/progress-and-cancellation.test.ts`

- [ ] **Step 1: Write failing SDK contract tests**

Add tests that call one method in each namespace with camelCase options and assert the resolved use-case receives internal hooks:

```ts
const controller = new AbortController();
const on_progress = vi.fn();
await api.backup('owner', { onProgress: on_progress, signal: controller.signal });
const options = vi.mocked(use_case.backup).mock.calls[0]![2];
expect(options.on_progress).toBe(on_progress);
expect(options.should_interrupt?.()).toBe(false);
controller.abort();
expect(options.should_interrupt?.()).toBe(true);
```

Also add compile-time assignments proving all affected results require `interrupted` and progress events reject invalid operation/phase strings.

- [ ] **Step 2: Run the SDK test and verify failure**

Run: `pnpm --filter @wisecom/atlas-sdk exec vitest run tests/unit/progress-and-cancellation.test.ts`

Expected: FAIL because `onProgress`, `signal`, and the adapter do not exist.

- [ ] **Step 3: Add the common public contract**

Implement and export:

```ts
interface OperationProgressBase {
  readonly operation: 'backup' | 'restore' | 'save' | 'verify';
  readonly workload: 'outlook' | 'onedrive' | 'sharepoint';
  readonly processed: number;
  readonly total?: number;
  readonly current?: string;
  readonly rate?: number;
}

export type OperationProgressEvent =
  | (OperationProgressBase & { readonly phase: 'discovering' })
  | (OperationProgressBase & { readonly phase: 'processing' })
  | (OperationProgressBase & { readonly phase: 'finalizing' })
  | (OperationProgressBase & { readonly phase: 'completed' })
  | (OperationProgressBase & { readonly phase: 'interrupted' });

export type OperationProgressPhase = OperationProgressEvent['phase'];
export type OperationProgressCallback = (event: OperationProgressEvent) => void;

export interface SdkOperationOptions {
  readonly onProgress?: OperationProgressCallback;
  readonly signal?: AbortSignal;
}

export interface OperationControlOptions {
  readonly on_progress?: OperationProgressCallback;
  readonly should_interrupt?: () => boolean;
}
```

Extend every internal backup/restore/save/verify option interface with `OperationControlOptions`. Outlook SDK backup options omit `progress`, `should_interrupt`, and `should_force_stop`; OneDrive SDK backup options omit `create_progress`, `on_progress`, and `should_interrupt`; SharePoint SDK backup options omit `on_progress` and `should_interrupt`; restore/save/verify SDK options omit `progress`, `on_progress`, and `should_interrupt`. Add required `interrupted: boolean` to Outlook `SyncResult` and to the OneDrive/SharePoint backup, restore, save, and verification result contracts.

- [ ] **Step 4: Implement the SDK adapter and update all factories**

```ts
export function adapt_operation_options<T extends SdkOperationOptions>(
  options: T,
): Omit<T, 'onProgress' | 'signal'> & OperationControlOptions {
  const { onProgress: on_progress, signal, ...rest } = options;
  return {
    ...rest,
    on_progress,
    should_interrupt: signal ? () => signal.aborted : undefined,
  };
}
```

Apply it to backup, restore, save, and verify in all three namespace factories. Do not adapt short catalog/status/deletion calls.

- [ ] **Step 5: Run SDK/types checks**

Run:

```bash
pnpm --filter @wisecom/atlas-types build
pnpm --filter @wisecom/atlas-sdk exec vitest run tests/unit/progress-and-cancellation.test.ts
pnpm --filter @wisecom/atlas-sdk typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the public-contract scope**

```bash
git add packages/types packages/sdk
git commit -m "feat(sdk): add progress and cancellation contracts"
```

### Task 2: Outlook and shared verification progress/cancellation

**Files:**
- Create: `packages/core/src/services/shared/operation-progress.ts`
- Modify: `packages/core/src/services/verification/verification.service.ts`
- Modify: `packages/outlook/src/services/backup/mailbox-sync.service.ts`
- Modify: `packages/outlook/src/services/restore/restore.service.ts`
- Modify: `packages/outlook/src/services/restore/restore-loop-executor.ts`
- Modify: `packages/outlook/src/services/save/save.service.ts`
- Modify: `packages/outlook/src/services/save/save-entry-processor.ts`
- Test: `packages/outlook/tests/unit/mailbox-sync.service.test.ts`
- Test: `packages/outlook/tests/unit/interrupt-delta-safeguard.test.ts`
- Test: `packages/outlook/tests/unit/restore.service.test.ts`
- Test: `packages/outlook/tests/unit/save.service.test.ts`
- Test: `packages/core/tests/unit/services/verification.service.test.ts`

- [ ] **Step 1: Write failing Outlook lifecycle and cancellation tests**

For each operation, record events and abort after the first `processing` event:

```ts
const events: OperationProgressEvent[] = [];
let interrupted = false;
const result = await service.run('tenant', 'owner', {
  on_progress: (event) => {
    events.push(event);
    if (event.phase === 'processing') interrupted = true;
  },
  should_interrupt: () => interrupted,
});
expect(result.interrupted).toBe(true);
expect(events.at(-1)?.phase).toBe('interrupted');
```

Keep the existing issue #23 assertion: an interrupted Outlook backup does not persist the delta link past unprocessed messages.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @wisecom/atlas-outlook exec vitest run tests/unit/mailbox-sync.service.test.ts tests/unit/interrupt-delta-safeguard.test.ts tests/unit/restore.service.test.ts tests/unit/save.service.test.ts
pnpm --filter @wisecom/atlas-core exec vitest run tests/unit/services/verification.service.test.ts
```

Expected: FAIL on missing events/result fields and absent cancellation polling.

- [ ] **Step 3: Add a callback-safe event emitter**

```ts
export function emit_operation_progress(
  callback: OperationProgressCallback | undefined,
  event: OperationProgressEvent,
): void {
  try {
    callback?.(event);
  } catch (err) {
    logger.debug(`Progress callback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Wire Outlook operations at existing safe points**

Emit `discovering`, monotonic `processing`, `finalizing`, and one terminal event. Reuse Outlook backup's existing interruption predicates and reporter. Remove service-owned SIGINT registration from save; CLI signal handling remains in CLI adapters. Return partial counters with `interrupted: true` from restore/save/verify.

- [ ] **Step 5: Run Outlook/core suites and typechecks**

Run:

```bash
pnpm --filter @wisecom/atlas-outlook test
pnpm --filter @wisecom/atlas-core test
pnpm --filter @wisecom/atlas-outlook typecheck
pnpm --filter @wisecom/atlas-core typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the Outlook scope**

```bash
git add packages/core packages/outlook
git commit -m "feat(outlook): report progress and graceful cancellation"
```

### Task 3: OneDrive progress, cancellation, and cursor safety

**Files:**
- Modify: `packages/onedrive/src/services/onedrive-backup.service.ts`
- Modify: `packages/onedrive/src/services/onedrive-backup-drive-processor.ts`
- Modify: `packages/onedrive/src/services/onedrive-backup-builders.ts`
- Modify: `packages/onedrive/src/services/onedrive-restore.service.ts`
- Modify: `packages/onedrive/src/services/onedrive-save.service.ts`
- Modify: `packages/onedrive/src/services/onedrive-verification.service.ts`
- Test: `packages/onedrive/tests/unit/services/onedrive-backup-drive-processor.test.ts`
- Test: `packages/onedrive/tests/unit/services/onedrive-backup-determinism.test.ts`
- Test: `packages/onedrive/tests/unit/services/onedrive-restore.service.test.ts`
- Test: `packages/onedrive/tests/unit/services/onedrive-save.service.test.ts`
- Test: `packages/onedrive/tests/unit/services/onedrive-verification.service.test.ts`

- [ ] **Step 1: Write failing OneDrive cancellation tests**

Model two changed items, abort after the first, and assert the second is untouched and the newly fetched delta link is not saved:

```ts
expect(result.interrupted).toBe(true);
expect(connector.download_file).toHaveBeenCalledTimes(1);
expect(delta_repository.save).not.toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({ delta_link: 'new-link' }),
);
expect(events.at(-1)?.phase).toBe('interrupted');
```

Add analogous partial-result tests for restore/save/verify and a completed-run event-order test.

- [ ] **Step 2: Run focused OneDrive tests and verify failure**

Run: `pnpm --filter @wisecom/atlas-onedrive exec vitest run tests/unit/services/onedrive-backup-drive-processor.test.ts tests/unit/services/onedrive-backup-determinism.test.ts tests/unit/services/onedrive-restore.service.test.ts tests/unit/services/onedrive-save.service.test.ts tests/unit/services/onedrive-verification.service.test.ts`

Expected: FAIL on missing cancellation checks and interrupted results.

- [ ] **Step 3: Add safe-point polling and event emission**

Check `should_interrupt?.()` before each drive and item, and after each completed item. Return an explicit interrupted drive outcome so the orchestrator excludes that drive's new delta link from cursor persistence. Emit one terminal event at service level.

- [ ] **Step 4: Add restore/save/verify partial results**

Poll between entries only; finish the current remote request. Preserve completed counts, stop new work, and return `interrupted: true`.

- [ ] **Step 5: Run OneDrive suite and typecheck**

Run:

```bash
pnpm --filter @wisecom/atlas-onedrive test
pnpm --filter @wisecom/atlas-onedrive typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the OneDrive scope**

```bash
git add packages/onedrive
git commit -m "feat(onedrive): add progress and safe cancellation"
```

### Task 4: SharePoint progress, cancellation, and cursor safety

**Files:**
- Modify: `packages/sharepoint/src/services/sharepoint-backup.service.ts`
- Modify: `packages/sharepoint/src/services/sharepoint-backup-library-processor.ts`
- Modify: `packages/sharepoint/src/services/sharepoint-restore.service.ts`
- Modify: `packages/sharepoint/src/services/sharepoint-save.service.ts`
- Modify: `packages/sharepoint/src/services/sharepoint-verification.service.ts`
- Test: `packages/sharepoint/tests/unit/services/sharepoint-backup-determinism.test.ts`
- Test: `packages/sharepoint/tests/unit/services/sharepoint-restore.service.test.ts`
- Test: `packages/sharepoint/tests/unit/services/sharepoint-save.service.test.ts`
- Test: `packages/sharepoint/tests/unit/services/sharepoint-verification.service.test.ts`

- [ ] **Step 1: Write failing SharePoint cancellation tests**

Abort inside a library after its first item. Assert partial counts, an `interrupted` terminal event, and no persistence of that library's new delta link. Also prove a fully completed earlier library may keep its cursor.

- [ ] **Step 2: Run focused SharePoint tests and verify failure**

Run: `pnpm --filter @wisecom/atlas-sharepoint exec vitest run tests/unit/services/sharepoint-backup-determinism.test.ts tests/unit/services/sharepoint-restore.service.test.ts tests/unit/services/sharepoint-save.service.test.ts tests/unit/services/sharepoint-verification.service.test.ts`

Expected: FAIL on absent cancellation behavior.

- [ ] **Step 3: Implement library/item safe points**

Propagate an interrupted library outcome. Skip delta mutation and final cursor persistence for incomplete libraries; keep completed-library cursors. Emit monotonic lifecycle events and return partial results.

- [ ] **Step 4: Add restore/save/verify cancellation**

Poll between entries and preserve existing item-level error isolation. Return `interrupted: true` without converting cancellation into an operational error.

- [ ] **Step 5: Run SharePoint suite and typecheck**

Run:

```bash
pnpm --filter @wisecom/atlas-sharepoint test
pnpm --filter @wisecom/atlas-sharepoint typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the SharePoint scope**

```bash
git add packages/sharepoint
git commit -m "feat(sharepoint): add progress and safe cancellation"
```

### Task 5: SDK documentation, regression checks, and live E2E

**Files:**
- Modify: `docs/reference/sdk.md`
- Test: all workspace suites

- [ ] **Step 1: Add SDK examples and reference tables**

Document `onProgress`, `signal`, every event field/phase, graceful partial results, and safe-point semantics. Lead with a working example:

```ts
const controller = new AbortController();
const result = await atlas.outlook.backup('user@example.com', {
  signal: controller.signal,
  onProgress(event) {
    console.log(event.phase, event.processed, event.total);
    if (event.processed >= 100) controller.abort();
  },
});
console.log(result.interrupted);
```

- [ ] **Step 2: Run complete static and unit verification**

Run:

```bash
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run format:check
pnpm run docs:build
```

Expected: all commands exit 0; only documented pre-existing warnings may remain.

- [ ] **Step 3: Run live Wisecom/MinIO E2E**

Use the secure Atlas config without exporting secrets. Record tenant/storage pre-state, then:

1. Abort an Outlook SDK backup from its progress callback.
2. Assert `interrupted === true`, monotonic events, and terminal `interrupted`.
3. Rerun the same mailbox to completion and verify its completed manifest/content state.
4. Abort OneDrive and SharePoint backups after a processing event; verify incomplete drive/library cursors did not advance.
5. Exercise restore/save/verify callbacks against audit-created or existing read-only data, then permanently remove every tenant write.
6. Purge audit-created storage objects, versions, and delete markers; restore MinIO to its original state.

- [ ] **Step 4: Commit documentation after E2E confirms behavior**

```bash
git add docs/reference/sdk.md
git commit -m "docs(sdk): document progress and cancellation"
```

- [ ] **Step 5: Review the final diff and open the PR**

Confirm commit boundaries, no secrets/test-tenant names in the diff or PR, and a clean worktree. Push `feat/39-sdk-progress-abort` and open a PR against `release/v2.1.0-beta` with `Closes #39` in the body and exact verification evidence.
