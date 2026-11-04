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
import { AuthError } from '@wisecom/atlas-types';
import { TeamsBackupService } from '@/services/backup/backup.service';
import {
  backup_channel,
  type ChannelBackupOutput,
} from '@/services/backup/channel-backup-processor';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  lock_run_writes: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

function channel_entry(id: string): TeamsChannelEntry {
  return { id, channel: { id }, members: [], tabs: [], read_mode: 'full', threads: {} };
}

function channel_output(
  id: string,
  overrides: Partial<ChannelBackupOutput> = {},
): ChannelBackupOutput {
  return {
    entry: channel_entry(id),
    next_link: `link-${id}`,
    complete: true,
    interrupted: false,
    failed_roots: {},
    errors: [],
    warnings: [],
    ...overrides,
  };
}

interface PortOptions {
  readonly stored_links?: Record<string, string>;
  readonly previous?: TeamsSnapshotManifest | undefined;
  readonly channels?: Array<Record<string, unknown>>;
}

interface Ports {
  readonly service: TeamsBackupService;
  readonly connector: { get_team: Mock };
  readonly order: string[];
  readonly manifests: { save: Mock; find_latest_by_team: Mock };
  readonly cursors: { load: Mock; save: Mock };
}

function make_ports(options: PortOptions = {}): Ports {
  const order: string[] = [];
  const tenant_ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const factory = { create: vi.fn(async () => tenant_ctx) } as unknown as TenantContextFactory;
  const get_team = vi.fn(async () => ({ id: 'team-1', displayName: 'Team One' }));
  const connector = {
    get_team,
    list_team_members: vi.fn(async () => []),
    list_channels: vi.fn(
      async () => options.channels ?? [{ id: 'channel-1' }, { id: 'channel-2' }],
    ),
  } as unknown as TeamsConnector;
  const manifests = {
    save: vi.fn(async () => {
      order.push('manifest');
    }),
    find_latest_by_team: vi.fn(async () => options.previous),
  };
  const cursors = {
    load: vi.fn(async () =>
      options.stored_links === undefined
        ? undefined
        : { team_id: 'team-1', delta_link_by_channel: options.stored_links, updated_at: '' },
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
  return { service, connector: { get_team }, order, manifests, cursors };
}

describe('TeamsBackupService.backup_team', () => {
  beforeEach(() => {
    vi.mocked(backup_channel).mockReset();
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) =>
      channel_output(channel.id),
    );
  });

  it('normalizes an uppercase team id to lowercase for the connector, cursor and result', async () => {
    const ports = make_ports();

    const result = await ports.service.backup_team('tenant-1', 'TEAM-1', {});

    expect(ports.connector.get_team).toHaveBeenCalledWith('tenant-1', 'team-1');
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ team_id: 'team-1' }),
    );
    expect(result.team_id).toBe('team-1');
  });

  it('keeps a channel Graph no longer lists as deleted and drops its stored link', async () => {
    const gone = channel_entry('channel-gone');
    const previous = {
      team: { id: 'team-1' },
      members: [],
      channels: [gone],
    } as unknown as TeamsSnapshotManifest;
    const ports = make_ports({
      previous,
      stored_links: { 'channel-gone': 'link-gone', 'channel-1': 'link-old' },
    });

    const result = await ports.service.backup_team('tenant-1', 'team-1', {});

    const saved = ports.manifests.save.mock.calls[0]?.[1] as TeamsSnapshotManifest;
    const kept = saved.channels.find((c) => c.id === 'channel-gone');
    expect(kept?.deleted_at).toEqual(expect.any(String));
    expect(result.snapshot?.channels.map((c) => c.id)).toContain('channel-gone');
    const cursor = ports.cursors.save.mock.calls[0]?.[1];
    expect(cursor.delta_link_by_channel).not.toHaveProperty('channel-gone');
  });

  it('reports no content and saves only the cursor when the team has no channels', async () => {
    const ports = make_ports({ channels: [] });

    const result = await ports.service.backup_team('tenant-1', 'team-1', {});

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_content');
    expect(result.summary.snapshot_created).toBe(false);
    expect(ports.manifests.save).not.toHaveBeenCalled();
    expect(ports.cursors.save).toHaveBeenCalledTimes(1);
  });

  it('skips the manifest when a run changes nothing, and still saves the cursor', async () => {
    const first = make_ports();
    const first_result = await first.service.backup_team('tenant-1', 'team-1', {});
    expect(first_result.snapshot).toBeDefined();

    const second = make_ports({ previous: first_result.snapshot });
    const result = await second.service.backup_team('tenant-1', 'team-1', {});

    expect(result.summary.no_snapshot_reason).toBe('no_changes');
    expect(result.snapshot).toBeUndefined();
    expect(second.manifests.save).not.toHaveBeenCalled();
    expect(second.cursors.save).toHaveBeenCalledTimes(1);
  });

  it('saves the manifest before the cursor so a cursor never points past a missing snapshot', async () => {
    const ports = make_ports();

    await ports.service.backup_team('tenant-1', 'team-1', {});

    expect(ports.order).toEqual(['manifest', 'cursor']);
  });

  it('skips a channel owned by another tenant and reports it as a warning', async () => {
    const ports = make_ports({
      channels: [{ id: 'channel-1' }, { id: 'channel-2', tenantId: 'tenant-2' }],
    });

    const result = await ports.service.backup_team('tenant-1', 'team-1', {});

    const processed = vi.mocked(backup_channel).mock.calls.map((call) => call[1].id);
    expect(processed).toEqual(['channel-1']);
    expect(result.summary.warnings).toContain(
      'Channel channel-2 is owned by another tenant; skipped',
    );
  });

  it('records a channel that fails as an error, leaves the run unhealthy, and continues', async () => {
    vi.mocked(backup_channel).mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const ports = make_ports();

    const result = await ports.service.backup_team('tenant-1', 'team-1', {});

    expect(result.summary.errors).toEqual(['Channel channel-1: boom']);
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.channels_scanned).toBe(2);
  });

  it('rethrows an authentication failure on the first channel', async () => {
    vi.mocked(backup_channel).mockImplementationOnce(async () => {
      throw new AuthError('denied');
    });
    const ports = make_ports();

    await expect(ports.service.backup_team('tenant-1', 'team-1', {})).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('stores failed roots in the cursor and reports them as warnings', async () => {
    vi.mocked(backup_channel).mockImplementation(
      async (_scope, channel, _previous, _link, ledger) =>
        channel.id === 'channel-1'
          ? channel_output('channel-1', {
              complete: false,
              next_link: undefined,
              failed_roots: {
                'root-1': {
                  item_id: 'root-1',
                  drive_id: 'channel-1',
                  name: 'root-1',
                  reason: 'boom',
                  attempts: 1,
                  first_failed_at: '2025-01-01T00:00:00.000Z',
                  last_failed_at: '2025-01-01T00:00:00.000Z',
                },
              },
              errors: ['Channel channel-1 root root-1: boom'],
            })
          : channel_output(channel.id, { failed_roots: ledger }),
    );
    const ports = make_ports({ stored_links: { 'channel-1': 'link-old' } });

    const result = await ports.service.backup_team('tenant-1', 'team-1', {});

    const cursor = ports.cursors.save.mock.calls[0]?.[1];
    expect(Object.keys(cursor.failed_roots)).toEqual(['root-1']);
    expect(cursor.delta_link_by_channel).not.toHaveProperty('channel-1');
    expect(result.summary.warnings.some((w) => w.startsWith('Not backed up: root-1'))).toBe(true);
    expect(result.summary.healthy).toBe(false);
  });

  it('reports a channel id that is not in the team as an error', async () => {
    const ports = make_ports();

    const result = await ports.service.backup_team('tenant-1', 'team-1', {
      channel_id: 'channel-9',
    });

    expect(result.summary.errors).toContain('Channel channel-9 is not in team team-1');
    expect(backup_channel).not.toHaveBeenCalled();
  });
});
