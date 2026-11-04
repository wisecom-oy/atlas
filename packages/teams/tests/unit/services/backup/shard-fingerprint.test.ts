import { describe, expect, it } from 'vitest';
import type { TeamsChannelShard } from '@wisecom/atlas-types';
import { shard_fingerprint } from '@/services/backup/shard-fingerprint';
import { previous_shard, thread_entry } from './channel-backup-processor-harness';

function shard_with_members(member_ids: string[]): TeamsChannelShard {
  return {
    ...previous_shard({}, 'full'),
    members: member_ids.map((id) => ({ id })),
  };
}

describe('shard_fingerprint', () => {
  it('ignores the read mode, so a delta read and a full read of the same content match', () => {
    const full = previous_shard({ m1: thread_entry('m1') }, 'full');
    const delta = previous_shard({ m1: thread_entry('m1') }, 'delta');

    expect(shard_fingerprint(delta)).toBe(shard_fingerprint(full));
  });

  it('ignores the order of members', () => {
    const forward = shard_with_members(['member-a', 'member-b']);
    const reversed = shard_with_members(['member-b', 'member-a']);

    expect(shard_fingerprint(reversed)).toBe(shard_fingerprint(forward));
  });

  it('ignores the order of tabs', () => {
    const tab = (id: string): TeamsChannelShard['tabs'][number] => ({ id }) as never;
    const forward = { ...previous_shard({}, 'full'), tabs: [tab('tab-a'), tab('tab-b')] };
    const reversed = { ...previous_shard({}, 'full'), tabs: [tab('tab-b'), tab('tab-a')] };

    expect(shard_fingerprint(reversed)).toBe(shard_fingerprint(forward));
  });

  it('changes when a thread changes', () => {
    const before = previous_shard({ m1: thread_entry('m1') }, 'full');
    const after = previous_shard(
      { m1: { ...thread_entry('m1'), deleted_at: '2025-01-02' } },
      'full',
    );

    expect(shard_fingerprint(after)).not.toBe(shard_fingerprint(before));
  });
});
