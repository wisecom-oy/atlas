import {
  clear_item_failure,
  record_item_failure,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger, TeamsRootFetchResult, TeamsThread } from '@wisecom/atlas-types';
import {
  advance_hosted_recheck,
  type HostedRecheck,
  next_hosted_recheck,
} from '@/services/backup/hosted-recheck';

/** Why a root is applied: it changed in the read, it is in the failed-root ledger, or it awaits a hosted-content recheck. */
export type RootReason = 'changed' | 'retry' | 'recheck';

/** One root to apply: its id, why it is applied, and how to load its current state from Graph. */
export interface RootTask {
  readonly root_id: string;
  readonly reason: RootReason;
  readonly load: () => Promise<TeamsRootFetchResult>;
}

/** A root task's result once it was not interrupted. Only `applied` carries the thread to keep. */
export type RootOutcome =
  | { readonly kind: 'applied'; readonly thread: TeamsThread | undefined }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

/** A root task's result, including an interrupt that stops the pass. */
export type RootTaskOutcome = RootOutcome | { readonly kind: 'interrupted' };

/** What one root-apply pass has accumulated so far. */
export interface RootApplyState {
  threads: Record<string, TeamsThread>;
  failed_roots: FailedItemLedger;
  hosted_recheck: HostedRecheck;
  errors: string[];
  warnings: string[];
}

/** Records one root's outcome into the pass state: its thread, failure ledger, and hosted recheck. */
export function record_root_outcome(
  state: RootApplyState,
  channel_id: string,
  task: RootTask,
  outcome: RootOutcome,
): void {
  if (outcome.kind === 'failed') {
    record_failure(state, channel_id, task.root_id, outcome.message, false);
  } else if (outcome.kind === 'refused') {
    record_refusal(state, channel_id, task.root_id, outcome.message);
  } else if (outcome.kind === 'missing') {
    record_missing(state, channel_id, task);
  } else {
    record_applied(state, channel_id, task.root_id, outcome.thread);
  }
}

function record_failure(
  state: RootApplyState,
  channel_id: string,
  root_id: string,
  message: string,
  permanent: boolean,
): void {
  state.failed_roots = record_item_failure(state.failed_roots, {
    item_id: root_id,
    drive_id: channel_id,
    name: root_id,
    reason: message,
    ...(permanent ? { permanent: true } : {}),
  });
  state.errors.push(`Channel ${channel_id} root ${root_id}: ${message}`);
}

/** A 400 from Graph is permanent, so the root leaves the recheck as well. */
function record_refusal(
  state: RootApplyState,
  channel_id: string,
  root_id: string,
  message: string,
): void {
  record_failure(state, channel_id, root_id, message, true);
  // Graph refused the root, so a recheck would be refused too.
  state.hosted_recheck = Object.fromEntries(
    Object.entries(state.hosted_recheck).filter(([id]) => id !== root_id),
  );
}

/**
 * A 404 is not proof of removal, so the thread is kept. A recheck root advances its count; any
 * other root counts an attempt in the ledger.
 */
function record_missing(state: RootApplyState, channel_id: string, task: RootTask): void {
  if (task.reason === 'recheck') {
    state.hosted_recheck = {
      ...state.hosted_recheck,
      [task.root_id]: advance_hosted_recheck(
        channel_id,
        task.root_id,
        state.hosted_recheck[task.root_id],
        state.warnings,
      ),
    };
  } else {
    state.failed_roots = record_item_failure(state.failed_roots, {
      item_id: task.root_id,
      drive_id: channel_id,
      name: task.root_id,
      reason: 'Graph returned 404 for the root or its replies',
    });
  }
  state.warnings.push(
    `Channel ${channel_id} root ${task.root_id}: Graph returned 404; kept as previously stored`,
  );
}

function record_applied(
  state: RootApplyState,
  channel_id: string,
  root_id: string,
  thread: TeamsThread | undefined,
): void {
  if (thread === undefined) delete state.threads[root_id];
  else state.threads[root_id] = thread;
  state.failed_roots = clear_item_failure(state.failed_roots, root_id);
  state.hosted_recheck = next_hosted_recheck(
    state.hosted_recheck,
    channel_id,
    root_id,
    thread,
    state.warnings,
  );
}
