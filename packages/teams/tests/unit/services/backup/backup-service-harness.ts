import { vi, type Mock } from 'vitest';
import type {
  FailedItemLedger,
  TeamsChannelEntry,
  TeamsConnector,
  TeamsDeltaCursorRepository,
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TeamsBackupService } from '@/services/backup/backup.service';
import type { ChannelBackupOutput } from '@/services/backup/channel-backup-processor';

export const TEAM_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

export function channel_entry(id: string): TeamsChannelEntry {
  return { id, channel: { id }, members: [], tabs: [], read_mode: 'full', threads: {} };
}

export function channel_output(
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
  readonly failed_roots?: FailedItemLedger;
  readonly previous?: TeamsSnapshotManifest | undefined;
  readonly channels?: Array<Record<string, unknown>>;
  readonly team?: Record<string, unknown>;
}

interface Ports {
  readonly service: TeamsBackupService;
  readonly connector: { get_team: Mock };
  readonly order: string[];
  readonly manifests: { save: Mock; find_latest_by_team: Mock };
  readonly cursors: { load: Mock; save: Mock };
}

export function make_ports(options: PortOptions = {}): Ports {
  const order: string[] = [];
  const tenant_ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const factory = { create: vi.fn(async () => tenant_ctx) } as unknown as TenantContextFactory;
  const get_team = vi.fn(async () => ({
    id: TEAM_ID,
    displayName: 'Team One',
    ...options.team,
  }));
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
    find_latest_by_team: vi.fn(async () => ({
      manifest: options.previous,
      unreadable_keys: [],
    })),
  };
  const cursors = {
    load: vi.fn(async () =>
      options.stored_links === undefined
        ? undefined
        : {
            team_id: TEAM_ID,
            delta_link_by_channel: options.stored_links,
            failed_roots: options.failed_roots ?? {},
            updated_at: '',
          },
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
