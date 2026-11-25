import { describe, expect, it, vi } from 'vitest';
import {
  GraphUnavailableError,
  ThrottledError,
  type TeamsFilesFolderRef,
} from '@wisecom/atlas-types';
import { backup_channel, type ChannelStartState } from '@/services/backup/channel-backup-processor';
import {
  CHANNEL,
  SHARED_CHANNEL,
  make_connector,
  make_scope,
  previous_shard,
} from './channel-backup-processor-harness';

/**
 * Issue #881: the files folder and shared teams lookups keep the previous value on a failure of
 * their own, but an exhausted retry budget is a Graph outage and fails the channel, which then
 * keeps its previous checkpoint, instead of a warning and a channel that carries on.
 */

const FOLDER: TeamsFilesFolderRef = { drive_id: 'drive-1', item_id: 'item-1' };

function start(overrides: Partial<ChannelStartState> = {}): ChannelStartState {
  return {
    previous_entry: undefined,
    previous_shard: undefined,
    stored_link: undefined,
    failed_roots: {},
    hosted_recheck: {},
    ...overrides,
  };
}

const OUTAGES = [
  [
    'GraphUnavailableError',
    () => new GraphUnavailableError('Graph unavailable', { retries: 12, elapsed_ms: 1_411_000 }),
  ],
  ['ThrottledError', () => new ThrottledError('Graph kept throttling', 30_000)],
] as const;

describe('backup_channel lookups during a Graph outage', () => {
  it.each(OUTAGES)('fails the channel when the files folder lookup ends in %s', async (_, make) => {
    const outage = make();
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => {
        throw outage;
      }),
    });

    const backup = backup_channel(
      make_scope(connector, undefined, true),
      CHANNEL,
      start({ previous_shard: { ...previous_shard({}), files_folder: FOLDER } }),
    );

    await expect(backup).rejects.toBe(outage);
  });

  it.each(OUTAGES)('fails the channel when the shared teams lookup ends in %s', async (_, make) => {
    const outage = make();
    const connector = make_connector({
      list_channel_shared_teams: vi.fn(async () => {
        throw outage;
      }),
    });

    const backup = backup_channel(
      make_scope(connector),
      SHARED_CHANNEL,
      start({ previous_shard: { ...previous_shard({}), shared_with_teams: [{ id: 'old-team' }] } }),
    );

    await expect(backup).rejects.toBe(outage);
  });

  it('keeps the previous folder with a warning for a lookup failure of its own', async () => {
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => {
        throw Object.assign(new Error('itemNotFound'), { statusCode: 404 });
      }),
    });

    const output = await backup_channel(
      make_scope(connector, undefined, true),
      CHANNEL,
      start({ previous_shard: { ...previous_shard({}), files_folder: FOLDER } }),
    );

    expect(output.shard.files_folder).toEqual(FOLDER);
    expect(output.warnings).toContain(
      'Channel channel-1: files folder not resolved (itemNotFound); kept the previous value',
    );
  });
});
