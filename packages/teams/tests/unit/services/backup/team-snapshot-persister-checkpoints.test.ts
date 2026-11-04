import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelCheckpointHead,
  TeamsChannelCursorRepository,
  TeamsChannelIndexEntry,
  TeamsGraphResource,
  TeamsIndexRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { ChannelBackupOutput } from '@/services/backup/channel-backup-processor';
import {
  persist_team_snapshot,
  type SnapshotPorts,
} from '@/services/backup/team-snapshot-persister';
import { BACKUP_AT, TEAM_ID } from './channel-backup-processor-harness';
import { channel_output } from './backup-service-harness';

const CTX = {} as TenantContext;
const TEAM: TeamsGraphResource = { id: TEAM_ID, displayName: 'Team' };
const ENTRY: TeamsChannelIndexEntry = {
  channel_id: 'channel-1',
  shard_key: 'shard-new',
  shard_checksum: 'sum-new',
  thread_count: 0,
  message_count: 0,
  size_bytes: 0,
};
const HEAD: TeamsChannelCheckpointHead = {
  format_version: 1,
  team_id: TEAM_ID,
  channel_id: 'channel-1',
  start_link: undefined,
  pending_delta_link: undefined,
  baseline_shard_key: 'shard-old',
  mode: 'full',
  phase: 'list',
  next_page: 'page-2',
  segments: [],
  failed_roots: {},
  hosted_recheck: {},
  updated_at: BACKUP_AT,
};

function build_ports(fail_cursor = false) {
  const checkpoints = new InMemoryTeamsChannelCheckpointRepository();
  const cursor_save = vi.fn(async () => {
    if (fail_cursor) throw new Error('cursor store unavailable');
  });
  const ports: SnapshotPorts = {
    indexes: { save: vi.fn(async () => undefined) } as unknown as TeamsIndexRepository,
    cursors: { save: cursor_save } as unknown as TeamsChannelCursorRepository,
    checkpoints,
  };
  return { ports, checkpoints, cursor_save };
}

function persist(ports: SnapshotPorts, output: ChannelBackupOutput) {
  return persist_team_snapshot(CTX, ports, {
    tenant_id: 'tenant-1',
    team_id: TEAM_ID,
    team_display_name: 'Team',
    backup_at: new Date(BACKUP_AT),
    team: TEAM,
    members: [],
    channels: [ENTRY],
    previous: undefined,
    saves: [{ channel_id: 'channel-1', entry: ENTRY, output }],
  });
}

describe('persist_team_snapshot checkpoint settle', () => {
  it('deletes a finished channel checkpoint only after its cursor is saved', async () => {
    const { ports, checkpoints, cursor_save } = build_ports();
    const delete_spy = vi.spyOn(checkpoints, 'delete_channel');

    await persist(ports, channel_output('channel-1', { checkpoint: HEAD, interrupted: false }));

    expect(delete_spy).toHaveBeenCalledWith(CTX, TEAM_ID, 'channel-1');
    expect(cursor_save.mock.invocationCallOrder[0]).toBeLessThan(
      delete_spy.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('rebinds an interrupted channel checkpoint to the shard just saved', async () => {
    const { ports, checkpoints } = build_ports();
    const delete_spy = vi.spyOn(checkpoints, 'delete_channel');
    const save_head_spy = vi.spyOn(checkpoints, 'save_head');

    await persist(ports, channel_output('channel-1', { checkpoint: HEAD, interrupted: true }));

    expect(save_head_spy).toHaveBeenCalledWith(CTX, { ...HEAD, baseline_shard_key: 'shard-new' });
    expect(delete_spy).not.toHaveBeenCalled();
  });

  it('leaves storage alone when the channel produced no checkpoint', async () => {
    const { ports, checkpoints } = build_ports();
    const delete_spy = vi.spyOn(checkpoints, 'delete_channel');
    const save_head_spy = vi.spyOn(checkpoints, 'save_head');

    await persist(ports, channel_output('channel-1', { checkpoint: undefined }));

    expect(delete_spy).not.toHaveBeenCalled();
    expect(save_head_spy).not.toHaveBeenCalled();
  });

  it('keeps the checkpoint untouched when the cursor save fails', async () => {
    const { ports, checkpoints } = build_ports(true);
    const delete_spy = vi.spyOn(checkpoints, 'delete_channel');
    const save_head_spy = vi.spyOn(checkpoints, 'save_head');

    await expect(
      persist(ports, channel_output('channel-1', { checkpoint: HEAD, interrupted: false })),
    ).rejects.toThrow('cursor store unavailable');

    expect(delete_spy).not.toHaveBeenCalled();
    expect(save_head_spy).not.toHaveBeenCalled();
  });
});
