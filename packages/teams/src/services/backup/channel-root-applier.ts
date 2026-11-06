import {
  clear_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  AuthError,
  type FailedItemLedger,
  type TeamsRootChange,
  type TeamsRootFetchResult,
  type TeamsThread,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { MAX_HOSTED_RECHECK_ATTEMPTS } from '@/services/backup/hosted-recheck';
import {
  type RootApplyState,
  type RootReason,
  type RootTask,
  type RootTaskOutcome,
  record_root_outcome,
} from '@/services/backup/root-apply-outcome';
import { as_root_refusal, RootRefusal } from '@/services/backup/root-refusal';
import { mark_root_removed, store_thread } from '@/services/backup/thread-store';
import { canonical_json } from '@/services/shared/canonical-json';
import { error_message } from '@/services/shared/error-message';

/** The outcome of one batch of root tasks: roots it recorded, and whether an interrupt stopped it. */
export interface RootBatchResult {
  readonly processed: string[];
  readonly interrupted: boolean;
}

/**
 * Applies a batch of root tasks in order into the pass state. An interrupt stops the batch before the
 * next root; roots already recorded stay recorded.
 */
export async function apply_root_tasks(
  scope: BackupRunScope,
  channel_id: string,
  tasks: RootTask[],
  state: RootApplyState,
): Promise<RootBatchResult> {
  const processed: string[] = [];
  for (const task of tasks) {
    if (scope.should_interrupt()) return { processed, interrupted: true };
    const previous = state.threads[task.root_id];
    const outcome = await apply_task(scope, channel_id, task, previous, state.warnings);
    if (outcome.kind === 'interrupted') return { processed, interrupted: true };
    record_root_outcome(state, channel_id, task, outcome);
    processed.push(task.root_id);
  }
  return { processed, interrupted: false };
}

/**
 * Marks removed every live root a full read never listed, and drops the ledger and recheck entries
 * of roots it did not list. Returns the IDs of the roots it marked.
 */
export function apply_full_read_sweep(
  scope: BackupRunScope,
  state: RootApplyState,
  seen: ReadonlySet<string>,
): string[] {
  const removed = removed_unseen_roots(scope, state.threads, seen);
  Object.assign(state.threads, removed);
  state.failed_roots = clear_unseen_failures(state.failed_roots, seen);
  state.hosted_recheck = Object.fromEntries(
    Object.entries(state.hosted_recheck).filter(([root_id]) => seen.has(root_id)),
  );
  return Object.keys(removed);
}

/**
 * Applies one root task. An auth failure is rethrown so the channel stops. A failure during an
 * interrupt is reported as `interrupted`, not as a root failure.
 */
async function apply_task(
  scope: BackupRunScope,
  channel_id: string,
  task: RootTask,
  previous: TeamsThread | undefined,
  warnings: string[],
): Promise<RootTaskOutcome> {
  try {
    const fetched = await task.load();
    if (fetched.status === 'not_found') return { kind: 'missing' };
    const thread = await apply_one_root(scope, channel_id, fetched.change, previous, warnings);
    return { kind: 'applied', thread };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (scope.should_interrupt()) return { kind: 'interrupted' };
    if (err instanceof RootRefusal) {
      return err.status === 400 ? { kind: 'refused', message: err.message } : { kind: 'missing' };
    }
    return { kind: 'failed', message: error_message(err) };
  }
}

/** On a full read, the previously live roots the read did not return, each marked removed. */
function removed_unseen_roots(
  scope: BackupRunScope,
  previous_threads: Record<string, TeamsThread>,
  seen: ReadonlySet<string>,
): Record<string, TeamsThread> {
  const removed: Record<string, TeamsThread> = {};
  for (const [root_id, previous] of Object.entries(previous_threads)) {
    if (!seen.has(root_id) && previous.deleted_at === undefined) {
      removed[root_id] = count_deletion(scope, previous, mark_root_removed(scope, previous));
    }
  }
  return removed;
}

/** Drops the ledger entries of roots that a full read did not return. */
function clear_unseen_failures(
  ledger: FailedItemLedger,
  seen: ReadonlySet<string>,
): FailedItemLedger {
  let next = ledger;
  for (const root_id of Object.keys(ledger)) {
    if (!seen.has(root_id)) next = clear_item_failure(next, root_id);
  }
  return next;
}

/** One task per root a page returned: the version the page carries is the one applied. */
export function changed_tasks(changes: TeamsRootChange[]): RootTask[] {
  return changes.map((change) => ({
    root_id: change.root.id,
    reason: 'changed' as const,
    load: async (): Promise<TeamsRootFetchResult> => ({ status: 'found', change }),
  }));
}

/** A root a retry pass re-reads, and why. */
export interface RetryRoot {
  readonly root_id: string;
  readonly reason: Exclude<RootReason, 'changed'>;
}

/**
 * The roots a retry pass still owes the channel: retryable ledger roots first, then recheck roots
 * under the limit that have no failure record. Roots the read already applied are left out.
 */
export function pending_retry_roots(
  state: RootApplyState,
  channel_id: string,
  seen: ReadonlySet<string>,
): RetryRoot[] {
  const retry = retryable_items(state.failed_roots, channel_id)
    .map((record) => record.item_id)
    .filter((root_id) => !seen.has(root_id))
    .map((root_id): RetryRoot => ({ root_id, reason: 'retry' }));
  const recheck = Object.entries(state.hosted_recheck)
    .filter(
      ([root_id, attempts]) =>
        attempts < MAX_HOSTED_RECHECK_ATTEMPTS &&
        !seen.has(root_id) &&
        !(root_id in state.failed_roots),
    )
    .map(([root_id]): RetryRoot => ({ root_id, reason: 'recheck' }));
  return [...retry, ...recheck];
}

/** A root re-read by id for a retry or recheck; the applier classifies its Graph refusals. */
export function fetched_task(
  scope: BackupRunScope,
  channel_id: string,
  root_id: string,
  reason: Exclude<RootReason, 'changed'>,
): RootTask {
  return {
    root_id,
    reason,
    load: () =>
      as_root_refusal(() =>
        scope.connector.get_channel_message(scope.tenant_id, scope.team_id, channel_id, root_id),
      ),
  };
}

/**
 * Applies one change and returns the thread to keep, or undefined when a root Graph removed was
 * never stored. A root's replies come from the change when Graph inlined them, otherwise from a
 * reply listing. A removed root is not re-listed: its inline replies, or none, are stored, and the
 * previous replies carry over.
 */
async function apply_one_root(
  scope: BackupRunScope,
  channel_id: string,
  change: TeamsRootChange,
  previous: TeamsThread | undefined,
  warnings: string[],
): Promise<TeamsThread | undefined> {
  if (change.deleted && typeof change.root.deletedDateTime !== 'string') {
    return previous === undefined
      ? undefined
      : count_deletion(scope, previous, mark_root_removed(scope, previous));
  }
  const replies =
    change.replies ??
    (change.deleted
      ? []
      : await as_root_refusal(() =>
          scope.connector.list_replies(scope.tenant_id, scope.team_id, channel_id, change.root.id),
        ));
  const stored = await store_thread(scope, channel_id, previous, change.root, replies);
  const changed =
    previous === undefined || canonical_json(previous) !== canonical_json(stored.thread);
  if (changed) scope.counters.threads_changed++;
  scope.counters.messages_stored += stored.stored;
  scope.counters.messages_deduplicated += stored.deduped;
  warnings.push(...stored.warnings);
  return count_deletion(scope, previous, stored.thread);
}

/** Counts a thread that became removed in this run, and returns it unchanged. */
function count_deletion(
  scope: BackupRunScope,
  previous: TeamsThread | undefined,
  thread: TeamsThread,
): TeamsThread {
  if (thread.deleted_at !== undefined && previous?.deleted_at === undefined) {
    scope.counters.threads_deleted++;
  }
  return thread;
}
