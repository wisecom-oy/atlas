/**
 * Issue #623: a Teams run that lost its team must not journal hosted content into the checkpoint
 * the new holder is working from.
 */
import { describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError, type HeldOwnerLease } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { open_channel_run, type ChannelRunStart } from '@/services/backup/channel-run-state';
import { channel_hosted_journal } from '@/services/backup/hosted-journal';
import { CHANNEL, make_connector, make_scope } from './channel-backup-processor-harness';

const BASELINE: ChannelRunStart = {
  baseline_shard_key: 'shard-1',
  stored_link: 'link-1',
  threads: {},
  failed_roots: {},
  hosted_recheck: {},
};

describe('the hosted journal and the team lease (issue #623)', () => {
  it('journals nothing once the lease is lost', async () => {
    let lost = false;
    const lease: HeldOwnerLease = {
      storage_key: 'lease',
      assert_held: () => {
        if (lost) {
          throw new OwnerLeaseLostError({ workload: 'teams', owner_id: 'team' }, 'taken over');
        }
      },
      release: async () => undefined,
    };
    const checkpoints = new InMemoryTeamsChannelCheckpointRepository();
    const save_hosted_entry = vi.spyOn(checkpoints, 'save_hosted_entry');
    const scope: BackupRunScope = { ...make_scope(make_connector()), checkpoints, lease };
    const run = await open_channel_run(scope, CHANNEL.id, BASELINE, 'delta', false);
    const journal = channel_hosted_journal(scope, run);
    const ref = { content_name: 'blob-1', size_bytes: 1 } as never;
    const at = { team_id: 'team', channel_id: CHANNEL.id, root_id: 'm1' };
    await journal.record(at, 'h1', ref);
    expect(save_hosted_entry).toHaveBeenCalledTimes(1);
    lost = true;

    const record = journal.record(at, 'h2', ref);

    await expect(record).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(save_hosted_entry).toHaveBeenCalledTimes(1);
  });
});
