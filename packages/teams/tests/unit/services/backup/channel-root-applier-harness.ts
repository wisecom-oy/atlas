import type { FailedItemLedger, TeamsRootChange, TeamsThread } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  apply_root_tasks,
  changed_tasks,
  drop_unlisted_root_tracking,
  fetched_task,
  pending_retry_roots,
} from '@/services/backup/channel-root-applier';
import type { HostedRecheck } from '@/services/backup/hosted-recheck';
import type { RootApplyState } from '@/services/backup/root-apply-outcome';

/** One channel read as a test describes it: the roots it returned, and whether it listed them all. */
export interface ChannelRootRead {
  readonly changes: TeamsRootChange[];
  readonly link: string | undefined;
  readonly is_full: boolean;
}

/** What applying one channel read left behind. */
export interface RootApplyOutput {
  readonly threads: Record<string, TeamsThread>;
  readonly failed_roots: FailedItemLedger;
  readonly hosted_recheck: HostedRecheck;
  readonly errors: string[];
  readonly warnings: string[];
  readonly interrupted: boolean;
}

/**
 * Applies one channel read through the same phases the reader runs: the returned roots, then the
 * retry and recheck roots it did not return, and on a full read the confirmation of live roots it
 * did not list.
 */
export async function apply_root_changes(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRootRead,
  previous_threads: Record<string, TeamsThread>,
  ledger: FailedItemLedger,
  previous_recheck: HostedRecheck,
): Promise<RootApplyOutput> {
  const state: RootApplyState = {
    threads: { ...previous_threads },
    failed_roots: ledger,
    hosted_recheck: { ...previous_recheck },
    errors: [],
    warnings: [],
  };
  const applied = await apply_root_tasks(scope, channel_id, changed_tasks(read.changes), state);
  if (applied.interrupted) return { ...state, interrupted: true };
  const seen = new Set(applied.processed);
  if (read.is_full) drop_unlisted_root_tracking(state, seen);
  const retry = pending_retry_roots(state, channel_id, seen, read.is_full).map((root) =>
    fetched_task(scope, channel_id, root.root_id, root.reason),
  );
  const retried = await apply_root_tasks(scope, channel_id, retry, state);
  return { ...state, interrupted: retried.interrupted };
}
