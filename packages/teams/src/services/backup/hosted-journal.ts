import type { TeamsHostedRef, TeamsMessageLocator } from '@wisecom/atlas-types';
import type { BackupRunScope, HostedJournal } from '@/services/backup/backup-run-scope';
import {
  checkpoint_ctx,
  flush_channel_run,
  type ChannelRun,
} from '@/services/backup/channel-run-state';

/** The journal key of one hosted item: `{root_id}/{reply_id}/{hosted_id}`, reply empty for a root. */
function journal_key(locator: TeamsMessageLocator, hosted_id: string): string {
  return `${locator.root_id}/${locator.reply_id ?? ''}/${hosted_id}`;
}

/**
 * The hosted journal of one channel read, kept in its checkpoint. Each entry is its own small
 * object, so journaling an item never rewrites the head or adds a segment (#620). Entries are only
 * read back under a matching head, so the first entry of a fresh read saves the head first.
 */
export function channel_hosted_journal(scope: BackupRunScope, run: ChannelRun): HostedJournal {
  let written = 0;
  return {
    lookup: (locator, hosted_id) => run.hosted.get(journal_key(locator, hosted_id)),
    record: async (locator, hosted_id, ref: TeamsHostedRef) => {
      const key = journal_key(locator, hosted_id);
      run.hosted.set(key, ref);
      if (run.head === undefined) await flush_channel_run(scope, run, { threads: [], seen: [] });
      const name = `${run.stamp}-${written++}`;
      await scope.checkpoints.save_hosted_entry(
        checkpoint_ctx(scope),
        scope.team_id,
        run.channel_id,
        name,
        { key, ref },
      );
    },
  };
}
