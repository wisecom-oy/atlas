import { describe, expect, it } from 'vitest';
import type {
  FailedItemLedger,
  FailedItemRecord,
  TeamsChannelEntry,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import {
  build_teams_cursor,
  build_teams_manifest,
  keep_ledger_for_channels,
} from '@/services/backup/backup-manifest-builder';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function blob(
  storage_key: string,
  size_bytes: number,
): { storage_key: string; checksum: string; size_bytes: number } {
  return { storage_key, checksum: `sha-${storage_key}`, size_bytes };
}

function thread(overrides: Partial<TeamsThreadEntry> = {}): TeamsThreadEntry {
  return {
    ...blob('k-root', 100),
    hosted: {},
    ...overrides,
  } as TeamsThreadEntry;
}

function channel(id: string, threads: Record<string, TeamsThreadEntry>): TeamsChannelEntry {
  return {
    id,
    channel: { id },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
  } as TeamsChannelEntry;
}

function failed(channel_id: string): FailedItemRecord {
  return {
    item_id: 'root-1',
    drive_id: channel_id,
    name: 'root-1',
    reason: 'boom',
    attempts: 1,
  } as FailedItemRecord;
}

describe('build_teams_manifest', () => {
  it('counts threads and sums every stored blob, including last_live (B3)', () => {
    const live_root = thread({
      ...blob('k-live', 10),
      hosted: { h1: blob('k-hosted', 20) } as TeamsThreadEntry['hosted'],
    });
    const deleted_root = thread({
      ...blob('k-tomb', 1),
      deleted_at: '2025-01-02T00:00:00.000Z',
      last_live: blob('k-last-live', 50),
    });

    const manifest = build_teams_manifest({
      tenant_id: 'tenant-1',
      team_id: TEAM,
      team_display_name: 'Team',
      snapshot_id: 'snap-1',
      created_at: CREATED_AT,
      team: { id: TEAM },
      members: [],
      channels: [channel('channel-1', { 'root-1': live_root, 'root-2': deleted_root })],
    });

    expect(manifest.total_threads).toBe(2);
    // live root 10, its hosted blob 20, tombstone 1, last_live 50
    expect(manifest.total_size_bytes).toBe(10 + 20 + 1 + 50);
    expect(manifest.id).toBe(`${TEAM}-snap-1`);
  });
});

describe('keep_ledger_for_channels (ledger pruning)', () => {
  it('drops failed-root records for channels the team no longer has', () => {
    const ledger: FailedItemLedger = {
      'channel-1/root-1': failed('channel-1'),
      'channel-removed/root-2': failed('channel-removed'),
    };

    const kept = keep_ledger_for_channels(ledger, new Set(['channel-1']));

    expect(Object.keys(kept)).toEqual(['channel-1/root-1']);
  });
});

describe('build_teams_cursor', () => {
  it('keeps links and failed roots only for channels the team still has', () => {
    const cursor = build_teams_cursor(
      TEAM,
      { 'channel-1': 'link-1', 'channel-removed': 'link-2' },
      new Set(['channel-1']),
      '2025-01-01T00:00:00.000Z',
      {
        'channel-1/root-1': failed('channel-1'),
        'channel-removed/root-2': failed('channel-removed'),
      },
    );

    expect(cursor.delta_link_by_channel).toEqual({ 'channel-1': 'link-1' });
    expect(Object.keys(cursor.failed_roots ?? {})).toEqual(['channel-1/root-1']);
    expect(cursor.team_id).toBe(TEAM);
  });
});
