import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  TeamsChannelEntry,
  TeamsConnector,
  TeamsDeltaCursorRepository,
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TeamsBackupService } from '@/services/backup/backup.service';
import { backup_channel } from '@/services/backup/channel-backup-processor';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  lock_run_writes: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

function channel_entry(id: string): TeamsChannelEntry {
  return {
    id,
    channel: { id },
    members: [],
    tabs: [],
    read_mode: 'delta',
    threads: {},
  };
}

interface Ports {
  readonly service: TeamsBackupService;
  readonly order: string[];
  readonly manifests: { save: Mock; find_latest_by_team: Mock };
  readonly cursors: { load: Mock; save: Mock };
}

function make_ports(
  stored_links: Record<string, string> | undefined,
  previous_channels: TeamsChannelEntry[] | undefined,
): Ports {
  const order: string[] = [];
  const tenant_ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const factory = { create: vi.fn(async () => tenant_ctx) } as unknown as TenantContextFactory;
  const connector = {
    get_team: vi.fn(async () => ({ id: 'team-1', displayName: 'Team One' })),
    list_team_members: vi.fn(async () => []),
    list_channels: vi.fn(async () => [{ id: 'channel-1' }, { id: 'channel-2' }]),
  } as unknown as TeamsConnector;
  const previous: TeamsSnapshotManifest | undefined =
    previous_channels === undefined
      ? undefined
      : ({ channels: previous_channels } as unknown as TeamsSnapshotManifest);
  const manifests = {
    save: vi.fn(async () => {
      order.push('manifest');
    }),
    find_latest_by_team: vi.fn(async () => previous),
  };
  const cursors = {
    load: vi.fn(async () =>
      stored_links === undefined
        ? undefined
        : { team_id: 'team-1', delta_link_by_channel: stored_links, updated_at: '' },
    ),
    save: vi.fn(async () => {
      order.push('cursor');
    }),
  };
  const service = new TeamsBackupService(
    factory,
    connector,
    manifests as unknown as TeamsManifestRepository,
    cursors as unknown as TeamsDeltaCursorRepository,
  );
  return { service, order, manifests, cursors };
}

describe('TeamsBackupService.backup_team', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
  });

  it('keeps other channels when one fails, saves the channel that failed as previous, and is unhealthy', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-2') {
        throw new Error('boom');
      }
      return { entry: channel_entry(channel.id), next_link: 'link-1' };
    });
    const ports = make_ports(undefined, undefined);
    const result = await ports.service.backup_team('tenant-1', 'team-1');
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual(['Channel channel-2: boom']);
    expect(result.snapshot?.channels.map((c) => c.id)).toEqual(['channel-1']);
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delta_link_by_channel: { 'channel-1': 'link-1' } }),
    );
  });

  it('keeps the previous entry and stored delta link for a channel that fails', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-2') {
        throw new Error('boom');
      }
      return { entry: channel_entry(channel.id), next_link: 'link-new' };
    });
    const previous = [channel_entry('channel-2')];
    const ports = make_ports({ 'channel-2': 'old-link' }, previous);
    const result = await ports.service.backup_team('tenant-1', 'team-1');
    expect(result.snapshot?.channels.find((c) => c.id === 'channel-2')).toEqual(previous[0]);
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        delta_link_by_channel: { 'channel-1': 'link-new', 'channel-2': 'old-link' },
      }),
    );
  });

  it('drops the stored read link for every channel when force_full is set', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => ({
      entry: channel_entry(channel.id),
      next_link: undefined,
    }));
    const ports = make_ports({ 'channel-1': 'stored-link' }, undefined);
    await ports.service.backup_team('tenant-1', 'team-1', { force_full: true });
    expect(backup_channel).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'channel-1' },
      undefined,
      undefined,
    );
  });

  it('saves the manifest before the cursor, so a cursor never points past recorded data', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => ({
      entry: channel_entry(channel.id),
      next_link: 'link',
    }));
    const ports = make_ports(undefined, undefined);
    await ports.service.backup_team('tenant-1', 'team-1');
    expect(ports.order).toEqual(['manifest', 'cursor']);
  });

  it('stops at the first interruption, still saves the manifest and cursor, and reports interrupted', async () => {
    vi.mocked(backup_channel).mockResolvedValue(undefined);
    const ports = make_ports(undefined, undefined);
    const result = await ports.service.backup_team('tenant-1', 'team-1');
    expect(result.interrupted).toBe(true);
    expect(result.summary.healthy).toBe(false);
    expect(backup_channel).toHaveBeenCalledTimes(1);
    expect(ports.order).toEqual(['manifest', 'cursor']);
  });
});
