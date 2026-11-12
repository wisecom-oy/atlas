import { describe, expect, it, vi } from 'vitest';
import {
  UnreadableContentError,
  UnsupportedFormatVersionError,
  type TeamsChannelShardRepository,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { load_channel_start_state } from '@/services/backup/channel-start-state';
import type { TeamsBaseline } from '@/services/backup/team-baseline-loader';
import {
  make_connector,
  make_scope,
  previous_shard,
  TEAM_ID,
} from './channel-backup-processor-harness';

const SHARD_KEY = 'teams/shards/team/channel-1/damaged.json';
const PREVIOUS_ENTRY = {
  channel_id: 'channel-1',
  shard_key: SHARD_KEY,
  shard_checksum: 'sum',
  thread_count: 1,
  message_count: 1,
  size_bytes: 1,
};

function baseline(): TeamsBaseline {
  return {
    previous: undefined,
    channels: new Map([
      [
        'channel-1',
        {
          previous_entry: PREVIOUS_ENTRY,
          delta_link: 'stored-link',
          failed_roots: {},
          hosted_recheck: { m1: 1 },
        },
      ],
    ]),
    unreadable_keys: [],
    warnings: [],
  };
}

function shards_failing_with(err: Error): TeamsChannelShardRepository {
  return { load: vi.fn(async () => Promise.reject(err)), save: vi.fn() };
}

function scope(force_full: boolean): BackupRunScope {
  return make_scope(make_connector(), () => false, force_full);
}

describe('load_channel_start_state', () => {
  it('starts from the previous shard and stored link when the shard reads cleanly', async () => {
    const shard = previous_shard({});
    const shards = { load: vi.fn(async () => shard), save: vi.fn() };

    const loaded = await load_channel_start_state(scope(false), 'channel-1', baseline(), shards);

    expect(loaded.start).toMatchObject({
      previous_entry: PREVIOUS_ENTRY,
      previous_shard: shard,
      stored_link: 'stored-link',
    });
    expect(loaded.start.unreadable_shard_key).toBeUndefined();
    expect(loaded.warnings).toEqual([]);
  });

  it('fails an unreadable shard without --full and names the recovery command', async () => {
    const shards = shards_failing_with(
      new UnreadableContentError(`The shard at ${SHARD_KEY} is missing`),
    );

    const load = load_channel_start_state(scope(false), 'channel-1', baseline(), shards);

    await expect(load).rejects.toBeInstanceOf(UnreadableContentError);
    await expect(load).rejects.toThrow(
      `atlas teams backup --team ${TEAM_ID} --channel channel-1 --full`,
    );
  });

  it('rebuilds an unreadable shard under --full as a new channel that keeps its cursor ledger', async () => {
    const shards = shards_failing_with(new UnreadableContentError('corrupt'));

    const loaded = await load_channel_start_state(scope(true), 'channel-1', baseline(), shards);

    expect(loaded.start).toEqual({
      previous_entry: undefined,
      previous_shard: undefined,
      stored_link: undefined,
      unreadable_shard_key: SHARD_KEY,
      failed_roots: {},
      hosted_recheck: { m1: 1 },
    });
    expect(loaded.warnings).toEqual([
      'Channel channel-1: corrupt; rebuilding the channel from Microsoft Graph (--full)',
    ]);
  });

  it.each([
    ['a storage error', new Error('connect ECONNRESET')],
    ['a newer-format shard', new UnsupportedFormatVersionError('newer')],
  ])('propagates %s unchanged under --full', async (_label, err) => {
    const load = load_channel_start_state(
      scope(true),
      'channel-1',
      baseline(),
      shards_failing_with(err),
    );

    await expect(load).rejects.toBe(err);
  });
});
