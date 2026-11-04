import { describe, expect, it, vi } from 'vitest';
import {
  UnreadableContentError,
  UnsupportedFormatVersionError,
  type FailedItemLedger,
  type TeamsChannelCursor,
  type TeamsChannelCursorRepository,
  type TeamsChannelIndexEntry,
  type TeamsIndexRepository,
  type TeamsSnapshotIndex,
  type TenantContext,
} from '@wisecom/atlas-types';
import { load_team_baseline, type BaselinePorts } from '@/services/backup/team-baseline-loader';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CTX = {} as TenantContext;
const BACKUP_AT = '2025-01-01T00:00:00.000Z';

function entry(channel_id: string, shard_key = `shard-${channel_id}`): TeamsChannelIndexEntry {
  return {
    channel_id,
    shard_key,
    shard_checksum: `sum-${channel_id}`,
    thread_count: 0,
    message_count: 0,
    size_bytes: 0,
  };
}

function index_with(channels: TeamsChannelIndexEntry[]): TeamsSnapshotIndex {
  return { team_id: TEAM, snapshot_id: 'snap-1', channels } as unknown as TeamsSnapshotIndex;
}

function cursor(overrides: Partial<TeamsChannelCursor> = {}): TeamsChannelCursor {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: 'channel-1',
    delta_link: 'stored-link',
    baseline_shard_key: 'shard-channel-1',
    updated_at: BACKUP_AT,
    ...overrides,
  };
}

function ports(
  latest: { index?: TeamsSnapshotIndex; unreadable_keys?: string[]; unsupported_keys?: string[] },
  cursor_result: TeamsChannelCursor | Error | undefined,
): BaselinePorts {
  const indexes = {
    find_latest_readable: vi.fn(async () => ({
      index: latest.index,
      unreadable_keys: latest.unreadable_keys ?? [],
      unsupported_keys: latest.unsupported_keys ?? [],
    })),
  } as unknown as TeamsIndexRepository;
  const cursors = {
    load: vi.fn(async () => {
      if (cursor_result instanceof Error) throw cursor_result;
      return cursor_result;
    }),
  } as unknown as TeamsChannelCursorRepository;
  return { indexes, cursors };
}

describe('load_team_baseline', () => {
  it('starts a channel from its previous entry and a delta link bound to the same shard', async () => {
    const latest = index_with([entry('channel-1')]);

    const baseline = await load_team_baseline(CTX, ports({ index: latest }, cursor()), TEAM, [
      'channel-1',
    ]);

    expect(baseline.previous).toBe(latest);
    expect(baseline.channels.get('channel-1')).toEqual({
      previous_entry: entry('channel-1'),
      delta_link: 'stored-link',
      failed_roots: {},
    });
    expect(baseline.warnings).toEqual([]);
    expect(baseline.errors).toEqual([]);
  });

  it('returns no previous entry and no delta link for a channel the latest index lacks', async () => {
    const baseline = await load_team_baseline(
      CTX,
      ports({ index: index_with([]) }, undefined),
      TEAM,
      ['channel-new'],
    );

    expect(baseline.channels.get('channel-new')).toEqual({
      previous_entry: undefined,
      delta_link: undefined,
      failed_roots: {},
    });
  });

  it('keeps the failed roots from the cursor even when its delta link is unusable', async () => {
    const failed: FailedItemLedger = {
      m1: {
        item_id: 'm1',
        drive_id: 'channel-1',
        name: 'm1',
        reason: 'r',
        attempts: 1,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };

    const baseline = await load_team_baseline(
      CTX,
      ports(
        { index: index_with([entry('channel-1')]) },
        cursor({ baseline_shard_key: 'older-shard', failed_roots: failed }),
      ),
      TEAM,
      ['channel-1'],
    );

    expect(baseline.channels.get('channel-1')?.delta_link).toBeUndefined();
    expect(baseline.channels.get('channel-1')?.failed_roots).toEqual(failed);
  });

  it('throws UnsupportedFormatVersionError before reading any cursor when an index is newer (N1)', async () => {
    const p = ports(
      { index: index_with([]), unsupported_keys: ['teams-snap-9999-cccccc'] },
      cursor(),
    );

    await expect(load_team_baseline(CTX, p, TEAM, ['channel-1'])).rejects.toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
    expect(p.cursors.load).not.toHaveBeenCalled();
  });

  it('drops the delta link and warns when the cursor was saved against an older shard (R10)', async () => {
    const baseline = await load_team_baseline(
      CTX,
      ports({ index: index_with([entry('channel-1')]) }, cursor({ baseline_shard_key: 'older' })),
      TEAM,
      ['channel-1'],
    );

    expect(baseline.channels.get('channel-1')?.delta_link).toBeUndefined();
    expect(baseline.warnings).toEqual([
      'The cursor for channel channel-1 does not match its latest shard; reading the channel in full',
    ]);
  });

  it('treats an unreadable cursor as absent and warns', async () => {
    const baseline = await load_team_baseline(
      CTX,
      ports(
        { index: index_with([entry('channel-1')]) },
        new UnreadableContentError('cursor is corrupt'),
      ),
      TEAM,
      ['channel-1'],
    );

    expect(baseline.channels.get('channel-1')).toEqual({
      previous_entry: entry('channel-1'),
      delta_link: undefined,
      failed_roots: {},
    });
    expect(baseline.warnings).toEqual([
      'The cursor for channel channel-1 is unreadable; reading the channel in full',
    ]);
  });

  it('rethrows a cursor error that is not an unreadable-content error', async () => {
    await expect(
      load_team_baseline(CTX, ports({ index: index_with([]) }, new Error('network down')), TEAM, [
        'channel-1',
      ]),
    ).rejects.toThrow('network down');
  });

  it('reports an unreadable index and falls back to an older snapshot', async () => {
    const baseline = await load_team_baseline(
      CTX,
      ports(
        { index: index_with([entry('channel-1')]), unreadable_keys: ['teams-snap-1000-aaaaaa'] },
        undefined,
      ),
      TEAM,
      ['channel-1'],
    );

    expect(baseline.previous?.snapshot_id).toBe('snap-1');
    expect(baseline.errors).toEqual([
      'Snapshot teams-snap-1000-aaaaaa could not be read; its channels were not compared',
    ]);
    expect(baseline.warnings).toEqual([
      'The baseline is an older snapshot because a newer one could not be read',
    ]);
  });
});
