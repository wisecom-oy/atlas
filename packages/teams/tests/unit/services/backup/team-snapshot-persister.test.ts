import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  TeamsChannelEntry,
  TeamsDeltaCursor,
  TeamsGraphResource,
  TeamsSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  persist_team_snapshot,
  snapshot_skip_reason,
  type SnapshotPersistInput,
  type SnapshotPorts,
} from '@/services/backup/team-snapshot-persister';

const BACKUP_AT = new Date('2025-01-01T00:00:00.000Z');
const TEAM: TeamsGraphResource = {
  id: '00000000-0000-0000-0000-000000000001',
  displayName: 'Team One',
};

function channel(id: string, overrides: Partial<TeamsChannelEntry> = {}): TeamsChannelEntry {
  return {
    id,
    channel: { id },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads: {},
    ...overrides,
  };
}

function input(overrides: Partial<SnapshotPersistInput> = {}): SnapshotPersistInput {
  return {
    tenant_id: 'tenant-1',
    team_id: '00000000-0000-0000-0000-000000000001',
    team_display_name: 'Team One',
    backup_at: BACKUP_AT,
    team: TEAM,
    members: [],
    channels: [channel('channel-1')],
    previous: undefined,
    links: {},
    channel_ids: new Set(['channel-1']),
    failed_roots: {},
    ...overrides,
  };
}

function make_ports(): {
  ports: SnapshotPorts;
  order: string[];
  save_manifest: Mock;
  save_cursor: Mock;
} {
  const order: string[] = [];
  const save_manifest = vi.fn(async () => {
    order.push('manifest');
  });
  const save_cursor = vi.fn(async () => {
    order.push('cursor');
  });
  const ports = {
    manifests: { save: save_manifest },
    cursors: { save: save_cursor },
  } as unknown as SnapshotPorts;
  return { ports, order, save_manifest, save_cursor };
}

const CTX = {} as TenantContext;

describe('snapshot_skip_reason', () => {
  it('skips a team with no channels as having no content', () => {
    expect(snapshot_skip_reason({ team: TEAM, members: [], channels: [] }, undefined)).toBe(
      'no_content',
    );
  });

  it('skips content identical to the previous snapshot as having no changes', () => {
    const content = { team: TEAM, members: [], channels: [channel('channel-1')] };

    expect(snapshot_skip_reason(content, { ...content })).toBe('no_changes');
  });

  it('ignores the read mode, so a delta read of unchanged content is not a change', () => {
    const previous = { team: TEAM, members: [], channels: [channel('channel-1')] };
    const content = {
      team: TEAM,
      members: [],
      channels: [channel('channel-1', { read_mode: 'delta' })],
    };

    expect(snapshot_skip_reason(content, previous)).toBe('no_changes');
  });

  it('ignores the order Graph returns members and tabs in', () => {
    const alice = { id: 'member-a' };
    const bob = { id: 'member-b' };
    const previous = {
      team: TEAM,
      members: [alice, bob],
      channels: [channel('channel-1', { members: [alice, bob], tabs: [alice, bob] })],
    };
    const content = {
      team: TEAM,
      members: [bob, alice],
      channels: [channel('channel-1', { members: [bob, alice], tabs: [bob, alice] })],
    };

    expect(snapshot_skip_reason(content, previous)).toBe('no_changes');
  });

  it('still sees a membership change', () => {
    const previous = {
      team: TEAM,
      members: [{ id: 'member-a' }],
      channels: [channel('channel-1')],
    };
    const content = {
      team: TEAM,
      members: [{ id: 'member-a' }, { id: 'member-b' }],
      channels: [channel('channel-1')],
    };

    expect(snapshot_skip_reason(content, previous)).toBeUndefined();
  });

  it('does not skip when the channels differ', () => {
    const previous = { team: TEAM, members: [], channels: [channel('channel-1')] };
    const content = {
      team: TEAM,
      members: [],
      channels: [channel('channel-1', { deleted_at: BACKUP_AT.toISOString() })],
    };

    expect(snapshot_skip_reason(content, previous)).toBeUndefined();
  });
});

describe('persist_team_snapshot', () => {
  it('saves the manifest before the cursor when the run changed something', async () => {
    const { ports, order } = make_ports();

    const result = await persist_team_snapshot(CTX, ports, input());

    expect(order).toEqual(['manifest', 'cursor']);
    expect(result.manifest).toBeDefined();
    expect(result.no_snapshot_reason).toBeUndefined();
  });

  it('saves only the cursor when the run changed nothing', async () => {
    const { ports, save_manifest, save_cursor } = make_ports();
    const previous = {
      team: TEAM,
      members: [],
      channels: [channel('channel-1')],
    } as unknown as TeamsSnapshotManifest;

    const result = await persist_team_snapshot(CTX, ports, input({ previous }));

    expect(save_manifest).not.toHaveBeenCalled();
    expect(save_cursor).toHaveBeenCalledTimes(1);
    expect(result.no_snapshot_reason).toBe('no_changes');
  });

  it('leaves the cursor where it was when the manifest save fails', async () => {
    const { ports, save_manifest, save_cursor } = make_ports();
    save_manifest.mockRejectedValueOnce(new Error('storage down'));

    await expect(persist_team_snapshot(CTX, ports, input())).rejects.toThrow('storage down');
    expect(save_cursor).not.toHaveBeenCalled();
  });

  it('stores links and failed roots only for channels the team still has', async () => {
    const { ports, save_cursor } = make_ports();

    await persist_team_snapshot(
      CTX,
      ports,
      input({
        links: { 'channel-1': 'link-kept', 'channel-gone': 'link-dropped' },
        channel_ids: new Set(['channel-1']),
        failed_roots: {
          'root-1': {
            item_id: 'root-1',
            drive_id: 'channel-1',
            name: 'root-1',
            reason: 'boom',
            attempts: 1,
            first_failed_at: BACKUP_AT.toISOString(),
            last_failed_at: BACKUP_AT.toISOString(),
          },
          'root-2': {
            item_id: 'root-2',
            drive_id: 'channel-gone',
            name: 'root-2',
            reason: 'boom',
            attempts: 1,
            first_failed_at: BACKUP_AT.toISOString(),
            last_failed_at: BACKUP_AT.toISOString(),
          },
        },
      }),
    );

    const cursor = save_cursor.mock.calls[0]?.[1] as TeamsDeltaCursor;
    expect(cursor.delta_link_by_channel).toEqual({ 'channel-1': 'link-kept' });
    expect(Object.keys(cursor.failed_roots ?? {})).toEqual(['root-1']);
  });

  it('saves the cursor but no manifest when the team has no channels', async () => {
    const { ports, save_manifest, save_cursor } = make_ports();

    const result = await persist_team_snapshot(CTX, ports, input({ channels: [] }));

    expect(save_manifest).not.toHaveBeenCalled();
    expect(save_cursor).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ manifest: undefined, no_snapshot_reason: 'no_content' });
  });

  it('names the manifest it just saved in the cursor', async () => {
    const { ports, save_cursor } = make_ports();

    const result = await persist_team_snapshot(CTX, ports, input());

    const cursor = save_cursor.mock.calls[0]?.[1] as TeamsDeltaCursor;
    expect(result.manifest).toBeDefined();
    expect(cursor.snapshot_id).toBe(result.manifest?.snapshot_id);
  });

  it('keeps the previous snapshot id in the cursor when the run changed nothing', async () => {
    const { ports, save_cursor } = make_ports();
    const previous = {
      snapshot_id: 'teams-snap-old',
      team: TEAM,
      members: [],
      channels: [channel('channel-1')],
    } as unknown as TeamsSnapshotManifest;

    await persist_team_snapshot(CTX, ports, input({ previous }));

    const cursor = save_cursor.mock.calls[0]?.[1] as TeamsDeltaCursor;
    expect(cursor.snapshot_id).toBe('teams-snap-old');
  });

  it('treats a channel with reordered keys as unchanged', async () => {
    const { ports, save_manifest } = make_ports();
    const previous = {
      team: TEAM,
      members: [],
      channels: [channel('channel-1', { channel: { id: 'channel-1', displayName: 'General' } })],
    } as unknown as TeamsSnapshotManifest;
    const reordered = channel('channel-1', {
      channel: { displayName: 'General', id: 'channel-1' },
    });

    const result = await persist_team_snapshot(
      CTX,
      ports,
      input({ channels: [reordered], previous }),
    );

    expect(save_manifest).not.toHaveBeenCalled();
    expect(result.no_snapshot_reason).toBe('no_changes');
  });
});
