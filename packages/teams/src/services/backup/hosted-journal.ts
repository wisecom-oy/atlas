import type { TeamsHostedRef, TeamsMessageLocator } from '@wisecom/atlas-types';
import type { BackupRunScope, HostedJournal } from '@/services/backup/backup-run-scope';
import { flush_channel_run, type ChannelRun } from '@/services/backup/channel-run-state';

/** The journal key of one hosted item: `{root_id}/{reply_id}/{hosted_id}`, reply empty for a root. */
function journal_key(locator: TeamsMessageLocator, hosted_id: string): string {
  return `${locator.root_id}/${locator.reply_id ?? ''}/${hosted_id}`;
}

/** The hosted journal of one channel read, kept in its checkpoint. */
export function channel_hosted_journal(scope: BackupRunScope, run: ChannelRun): HostedJournal {
  return {
    lookup: (locator, hosted_id) => run.hosted.get(journal_key(locator, hosted_id)),
    record: async (locator, hosted_id, ref: TeamsHostedRef) => {
      const key = journal_key(locator, hosted_id);
      run.hosted.set(key, ref);
      await flush_channel_run(scope, run, { threads: [], seen: [], hosted: { [key]: ref } });
    },
  };
}
