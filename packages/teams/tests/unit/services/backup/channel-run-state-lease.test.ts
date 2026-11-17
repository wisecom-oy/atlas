/**
 * Issue #623: a Teams run that lost its team to another operation must not advance or delete the
 * checkpoint the new holder is working from.
 */
import { describe, expect, it } from 'vitest';
import { OwnerLeaseLostError, type HeldOwnerLease } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  flush_channel_run,
  open_channel_run,
  type ChannelRunStart,
} from '@/services/backup/channel-run-state';
import {
  CHANNEL,
  make_connector,
  make_scope,
  TEAM_ID,
  thread_entry,
} from './channel-backup-processor-harness';

const BASELINE: ChannelRunStart = {
  baseline_shard_key: 'shard-1',
  stored_link: 'link-1',
  threads: {},
  failed_roots: {},
  hosted_recheck: {},
};

/** A lease the test can take away, as a renewal that found another holder would. */
function losable_lease(): { lease: HeldOwnerLease; lose: () => void } {
  let lost = false;
  const lease: HeldOwnerLease = {
    storage_key: 'lease',
    assert_held: () => {
      if (lost) {
        throw new OwnerLeaseLostError({ workload: 'teams', owner_id: TEAM_ID }, 'taken over');
      }
    },
    release: async () => undefined,
  };
  return { lease, lose: () => (lost = true) };
}

function scope_with(lease: HeldOwnerLease) {
  const checkpoints = new InMemoryTeamsChannelCheckpointRepository();
  const scope: BackupRunScope = { ...make_scope(make_connector()), checkpoints, lease };
  return { scope, checkpoints };
}

describe('channel checkpoints and the team lease (issue #623)', () => {
  it('saves no segment and no head once the lease is lost', async () => {
    const { lease, lose } = losable_lease();
    const { scope, checkpoints } = scope_with(lease);
    const run = await open_channel_run(scope, CHANNEL.id, BASELINE, 'delta', false);
    run.state.threads.a = thread_entry('a');
    await flush_channel_run(scope, run, { threads: ['a'], seen: ['a'] });
    const head_before = await checkpoints.load_head(scope.ctx, TEAM_ID, CHANNEL.id);
    lose();

    run.state.threads.b = thread_entry('b');
    const flush = flush_channel_run(scope, run, { threads: ['b'], seen: ['b'] });

    await expect(flush).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(await checkpoints.load_head(scope.ctx, TEAM_ID, CHANNEL.id)).toEqual(head_before);
    expect(head_before?.segments).toHaveLength(1);
  });

  it('does not discard a checkpoint it cannot resume once the lease is lost', async () => {
    const { lease, lose } = losable_lease();
    const { scope, checkpoints } = scope_with(lease);
    const run = await open_channel_run(scope, CHANNEL.id, BASELINE, 'delta', false);
    await flush_channel_run(scope, run, { threads: [], seen: ['a'] });
    lose();

    // A different baseline shard makes the stored checkpoint unusable, which normally deletes it.
    const reopened = open_channel_run(
      scope,
      CHANNEL.id,
      { ...BASELINE, baseline_shard_key: 'shard-2' },
      'delta',
      false,
    );

    await expect(reopened).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(await checkpoints.load_head(scope.ctx, TEAM_ID, CHANNEL.id)).toBeDefined();
  });
});
