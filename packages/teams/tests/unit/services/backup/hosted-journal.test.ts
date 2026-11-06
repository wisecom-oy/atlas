import { describe, expect, it } from 'vitest';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { open_channel_run, type ChannelRunStart } from '@/services/backup/channel-run-state';
import { channel_hosted_journal } from '@/services/backup/hosted-journal';
import { store_thread } from '@/services/backup/thread-store';
import { CHANNEL_ID, hosted_body, make_harness, message } from './thread-store-harness';

const START: ChannelRunStart = {
  baseline_shard_key: undefined,
  stored_link: undefined,
  threads: {},
  failed_roots: {},
  hosted_recheck: {},
};

const ROOT: TeamsGraphResource = message('root-1', {
  body: { contentType: 'html', content: hosted_body('root-1', 'h1') },
});

/** A scope whose hosted journal belongs to the channel read the checkpoint resumes, if any. */
async function journaled_scope(scope: BackupRunScope): Promise<BackupRunScope> {
  const run = await open_channel_run(scope, CHANNEL_ID, START, 'full', false);
  return { ...scope, hosted_journal: channel_hosted_journal(scope, run) };
}

describe('hosted journal', () => {
  it('reuses an image stored before a crash instead of downloading it again', async () => {
    const harness = make_harness();
    const scope: BackupRunScope = {
      ...harness.scope,
      checkpoints: new InMemoryTeamsChannelCheckpointRepository(),
    };

    // The run stores the image, then dies before the thread is recorded in any segment.
    await store_thread(await journaled_scope(scope), CHANNEL_ID, undefined, ROOT, []);
    const resumed = await store_thread(
      await journaled_scope(scope),
      CHANNEL_ID,
      undefined,
      ROOT,
      [],
    );

    expect(harness.download_hosted_content).toHaveBeenCalledTimes(1);
    expect(resumed.thread.root.hosted.h1?.storage_key).toBeDefined();
  });
});
