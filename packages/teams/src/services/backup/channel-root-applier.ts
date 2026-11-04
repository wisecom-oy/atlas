import {
  clear_item_failure,
  record_item_failure,
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
import type { ChannelRootRead } from '@/services/backup/channel-root-reader';
import {
  advance_hosted_recheck,
  type HostedRecheck,
  has_missing_hosted,
} from '@/services/backup/hosted-recheck';
import { mark_root_removed, store_thread } from '@/services/backup/thread-store';
import { error_message } from '@/services/shared/error-message';

/** What applying one channel's root changes produced. */
export interface RootApplyOutput {
  readonly threads: Record<string, TeamsThread>;
  /** This channel's failed roots, keyed by root id. */
  readonly failed_roots: FailedItemLedger;
  /** Roots whose hosted content is still missing, with their attempt counts. */
  readonly hosted_recheck: HostedRecheck;
  readonly errors: string[];
  readonly warnings: string[];
  readonly interrupted: boolean;
}

/** One root to apply: its id and how to load its current state from Graph. */
interface RootTask {
  readonly root_id: string;
  readonly load: () => Promise<TeamsRootFetchResult>;
}

/**
 * Applies a channel read to its previous thread map. A root that fails keeps its previous thread
 * and is recorded in the channel's failed-root ledger. A delta run re-fetches each ledger root and
 * each root with missing hosted content that the read did not return. A full read covers the whole
 * channel: a previous root it no longer lists is marked removed, and ledger and recheck roots it no
 * longer lists are dropped.
 */
export async function apply_root_changes(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRootRead,
  previous_threads: Record<string, TeamsThread>,
  ledger: FailedItemLedger,
  previous_recheck: HostedRecheck,
): Promise<RootApplyOutput> {
  const threads: Record<string, TeamsThread> = { ...previous_threads };
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let failed_roots = ledger;
  let hosted_recheck = { ...previous_recheck };
  for (const task of root_tasks(scope, channel_id, read, ledger, previous_recheck)) {
    if (scope.should_interrupt()) {
      return { threads, failed_roots, hosted_recheck, errors, warnings, interrupted: true };
    }
    seen.add(task.root_id);
    const outcome = await apply_task(
      scope,
      channel_id,
      task,
      previous_threads[task.root_id],
      warnings,
    );
    if (outcome.kind === 'interrupted') {
      return { threads, failed_roots, hosted_recheck, errors, warnings, interrupted: true };
    }
    if (outcome.kind === 'failed') {
      failed_roots = record_item_failure(failed_roots, {
        item_id: task.root_id,
        drive_id: channel_id,
        name: task.root_id,
        reason: outcome.message,
      });
      errors.push(`Channel ${channel_id} root ${task.root_id}: ${outcome.message}`);
      continue;
    }
    if (outcome.kind === 'missing') {
      // A 404 on re-read is not proof of removal: it counts an attempt and keeps the thread.
      failed_roots = record_item_failure(failed_roots, {
        item_id: task.root_id,
        drive_id: channel_id,
        name: task.root_id,
        reason: 'Graph returned 404 for the root on re-read',
      });
      warnings.push(
        `Channel ${channel_id} root ${task.root_id}: Graph returned 404 on re-read; kept as previously stored`,
      );
      continue;
    }
    if (outcome.thread === undefined) delete threads[task.root_id];
    else threads[task.root_id] = outcome.thread;
    failed_roots = clear_item_failure(failed_roots, task.root_id);
    hosted_recheck = next_recheck(
      hosted_recheck,
      channel_id,
      task.root_id,
      outcome.thread,
      warnings,
    );
  }
  if (read.is_full) {
    Object.assign(threads, removed_unseen_roots(scope, previous_threads, seen));
    failed_roots = clear_unseen_failures(failed_roots, seen);
    hosted_recheck = Object.fromEntries(
      Object.entries(hosted_recheck).filter(([root_id]) => seen.has(root_id)),
    );
  }
  return { threads, failed_roots, hosted_recheck, errors, warnings, interrupted: false };
}

/** Outcome of applying one root task. Only `applied` carries the thread to keep. */
type RootTaskOutcome =
  | { readonly kind: 'applied'; readonly thread: TeamsThread | undefined }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'interrupted' };

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

/**
 * Records one root's hosted-content state after it was applied: a root still missing content
 * advances its attempt count, and a resolved or removed root leaves the recheck.
 */
function next_recheck(
  recheck: HostedRecheck,
  channel_id: string,
  root_id: string,
  thread: TeamsThread | undefined,
  warnings: string[],
): HostedRecheck {
  const attempts =
    thread !== undefined && has_missing_hosted(thread)
      ? advance_hosted_recheck(channel_id, root_id, recheck[root_id], warnings)
      : undefined;
  const next = { ...recheck };
  if (attempts === undefined) delete next[root_id];
  else next[root_id] = attempts;
  return next;
}

/**
 * The roots to apply: every root the read returned, then, on a delta read, each retryable ledger
 * root and each recheck root that the read did not return. A full read already covers every root.
 */
function root_tasks(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRootRead,
  ledger: FailedItemLedger,
  recheck: HostedRecheck,
): RootTask[] {
  const returned = new Set(read.changes.map((change) => change.root.id));
  const retry_ids = read.is_full
    ? []
    : [
        ...new Set([
          ...retryable_items(ledger, channel_id).map((record) => record.item_id),
          ...Object.keys(recheck),
        ]),
      ].filter((root_id) => !returned.has(root_id));
  return [
    ...read.changes.map((change) => ({
      root_id: change.root.id,
      load: async (): Promise<TeamsRootFetchResult> => ({ status: 'found', change }),
    })),
    ...retry_ids.map((root_id) => ({
      root_id,
      load: () =>
        scope.connector.get_channel_message(scope.tenant_id, scope.team_id, channel_id, root_id),
    })),
  ];
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
