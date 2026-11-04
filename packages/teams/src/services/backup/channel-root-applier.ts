import {
  clear_item_failure,
  record_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  AuthError,
  type FailedItemLedger,
  type TeamsRootChange,
  type TeamsThread,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import type { ChannelRootRead } from '@/services/backup/channel-root-reader';
import { mark_root_removed, store_thread } from '@/services/backup/thread-store';
import { error_message } from '@/services/shared/error-message';

/** What applying one channel's root changes produced. */
export interface RootApplyOutput {
  readonly threads: Record<string, TeamsThread>;
  /** This channel's failed roots, keyed by root id. */
  readonly failed_roots: FailedItemLedger;
  readonly errors: string[];
  readonly warnings: string[];
  readonly interrupted: boolean;
}

/** One root to apply: its id and how to load its current change from Graph. */
interface RootTask {
  readonly root_id: string;
  readonly load: () => Promise<TeamsRootChange>;
}

/**
 * Applies a channel read to its previous thread map. A root that fails keeps its previous thread
 * and is recorded in the channel's failed-root ledger. A delta run re-fetches each ledger root the
 * read did not return, until its attempt budget is spent. A full read covers the whole channel:
 * a previous root it no longer lists is marked removed, and ledger roots it no longer lists are
 * dropped.
 * ponytail: the full read and each root's replies are held in memory before storing; a page
 * callback upgrades this for very large channels.
 */
export async function apply_root_changes(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRootRead,
  previous_threads: Record<string, TeamsThread>,
  ledger: FailedItemLedger,
): Promise<RootApplyOutput> {
  const threads: Record<string, TeamsThread> = { ...previous_threads };
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let failed_roots = ledger;
  for (const task of root_tasks(scope, channel_id, read, ledger)) {
    if (scope.should_interrupt()) {
      return { threads, failed_roots, errors, warnings, interrupted: true };
    }
    seen.add(task.root_id);
    const outcome = await apply_task(
      scope,
      channel_id,
      task,
      previous_threads[task.root_id],
      warnings,
    );
    if (outcome.failed) {
      failed_roots = record_item_failure(failed_roots, {
        item_id: task.root_id,
        drive_id: channel_id,
        name: task.root_id,
        reason: outcome.message,
      });
      errors.push(`Channel ${channel_id} root ${task.root_id}: ${outcome.message}`);
      continue;
    }
    if (outcome.thread === undefined) delete threads[task.root_id];
    else threads[task.root_id] = outcome.thread;
    failed_roots = clear_item_failure(failed_roots, task.root_id);
  }
  if (read.is_full) {
    Object.assign(threads, removed_unseen_roots(scope, previous_threads, seen));
    failed_roots = clear_unseen_failures(failed_roots, seen);
  }
  return { threads, failed_roots, errors, warnings, interrupted: false };
}

/** Outcome of applying one root: the thread to keep (undefined when removed), or the failure. */
type RootTaskOutcome =
  | { readonly failed: false; readonly thread: TeamsThread | undefined }
  | { readonly failed: true; readonly message: string };

/** Applies one root task. An auth failure is rethrown so the channel stops; other failures are returned. */
async function apply_task(
  scope: BackupRunScope,
  channel_id: string,
  task: RootTask,
  previous: TeamsThread | undefined,
  warnings: string[],
): Promise<RootTaskOutcome> {
  try {
    const change = await task.load();
    const thread = await apply_one_root(scope, channel_id, change, previous, warnings);
    return { failed: false, thread };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { failed: true, message: error_message(err) };
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

/**
 * The roots to apply: every root the read returned, then, on a delta read, each retryable ledger
 * root that the read did not return. A full read already covers every root, so it retries none.
 */
function root_tasks(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRootRead,
  ledger: FailedItemLedger,
): RootTask[] {
  const returned = new Set(read.changes.map((change) => change.root.id));
  const retry_ids = read.is_full
    ? []
    : retryable_items(ledger, channel_id)
        .map((record) => record.item_id)
        .filter((root_id) => !returned.has(root_id));
  return [
    ...read.changes.map((change) => ({ root_id: change.root.id, load: async () => change })),
    ...retry_ids.map((root_id) => ({
      root_id,
      load: () => load_ledger_root(scope, channel_id, root_id),
    })),
  ];
}

/** Re-fetches one ledger root from Graph. A root Graph no longer has is treated as removed. */
async function load_ledger_root(
  scope: BackupRunScope,
  channel_id: string,
  root_id: string,
): Promise<TeamsRootChange> {
  const change = await scope.connector.get_channel_message(
    scope.tenant_id,
    scope.team_id,
    channel_id,
    root_id,
  );
  return change ?? { root: { id: root_id }, deleted: true };
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
      : await scope.connector.list_replies(
          scope.tenant_id,
          scope.team_id,
          channel_id,
          change.root.id,
        ));
  const stored = await store_thread(scope, channel_id, previous, change.root, replies);
  scope.counters.threads_changed++;
  scope.counters.threads_stored += stored.stored;
  scope.counters.threads_deduplicated += stored.deduped;
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
