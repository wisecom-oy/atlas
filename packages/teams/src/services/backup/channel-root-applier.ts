import {
  clear_item_failure,
  record_item_failure,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger, TeamsRootChange, TeamsThreadEntry } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import type { ChannelRootRead } from '@/services/backup/channel-root-reader';
import { mark_thread_removed, store_thread } from '@/services/backup/thread-store';
import { error_message } from '@/services/shared/error-message';
import { migrate_legacy_root_keys, root_ledger_key } from '@/services/shared/root-ledger-key';

/** What applying one channel's root changes produced. */
export interface RootApplyOutput {
  readonly threads: Record<string, TeamsThreadEntry>;
  readonly failed_roots: FailedItemLedger;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/** One root to apply: its id and how to load its current change from Graph. */
interface RootTask {
  readonly root_id: string;
  readonly load: () => Promise<TeamsRootChange>;
}

/**
 * Applies a channel read to its previous thread map. A root that fails keeps its previous entry and
 * is recorded in the failed-root ledger. The next run re-fetches each ledger root the delta read did
 * not return, until its attempt budget is spent. A full read covers the whole channel, so a previous
 * root it no longer lists is marked removed.
 * ponytail: the full read and each root's replies are held in memory before storing; a page
 * callback upgrades this for very large channels.
 */
export async function apply_root_changes(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRootRead,
  previous_threads: Record<string, TeamsThreadEntry>,
  ledger: FailedItemLedger,
): Promise<RootApplyOutput> {
  const threads: Record<string, TeamsThreadEntry> = { ...previous_threads };
  const errors: string[] = [];
  const seen = new Set<string>();
  let failed_roots = migrate_legacy_root_keys(ledger, channel_id);
  for (const task of root_tasks(scope, channel_id, read.changes, failed_roots)) {
    if (scope.should_interrupt()) {
      return { threads, failed_roots, errors, interrupted: true };
    }
    const root_id = task.root_id;
    seen.add(root_id);
    try {
      const change = await task.load();
      const entry = await apply_one_root(scope, channel_id, change, previous_threads[root_id]);
      if (entry === undefined) {
        delete threads[root_id];
      } else {
        threads[root_id] = entry;
      }
      failed_roots = clear_item_failure(failed_roots, root_ledger_key(channel_id, root_id));
    } catch (err) {
      const message = error_message(err);
      failed_roots = record_item_failure(failed_roots, {
        item_id: root_ledger_key(channel_id, root_id),
        drive_id: channel_id,
        name: root_id,
        reason: message,
      });
      errors.push(`Channel ${channel_id} root ${root_id}: ${message}`);
    }
  }
  if (read.is_full) {
    for (const [root_id, previous] of Object.entries(previous_threads)) {
      if (!seen.has(root_id)) {
        threads[root_id] = mark_thread_removed(scope, previous);
        failed_roots = clear_item_failure(failed_roots, root_ledger_key(channel_id, root_id));
      }
    }
  }
  return { threads, failed_roots, errors, interrupted: false };
}

/**
 * The roots to apply: every root the read returned, then each retryable ledger root of this channel
 * that the read did not return.
 */
function root_tasks(
  scope: BackupRunScope,
  channel_id: string,
  changes: TeamsRootChange[],
  ledger: FailedItemLedger,
): RootTask[] {
  const returned = new Set(changes.map((change) => change.root.id));
  const retry_ids = retryable_items(ledger, channel_id)
    .map((record) => record.name)
    .filter((root_id) => !returned.has(root_id));
  return [
    ...changes.map((change) => ({ root_id: change.root.id, load: async () => change })),
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

/** Applies one change. Returns undefined when a root Graph removed was never stored. */
async function apply_one_root(
  scope: BackupRunScope,
  channel_id: string,
  change: TeamsRootChange,
  previous: TeamsThreadEntry | undefined,
): Promise<TeamsThreadEntry | undefined> {
  if (change.deleted && typeof change.root.deletedDateTime !== 'string') {
    return previous === undefined ? undefined : mark_thread_removed(scope, previous);
  }
  return store_thread(scope, channel_id, change, previous);
}
