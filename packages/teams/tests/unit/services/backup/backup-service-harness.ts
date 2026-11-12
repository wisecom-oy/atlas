import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { vi, type Mock } from 'vitest';
import type {
  FailedItemLedger,
  TeamsChannelCursor,
  TeamsChannelShard,
  TeamsConnector,
  TeamsChannelCursorRepository,
  TeamsChannelShardRepository,
  TeamsGraphResource,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import { TeamsBackupService } from '@/services/backup/backup.service';
import type { ChannelBackupOutput } from '@/services/backup/channel-backup-processor';

export const TEAM_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

/** A backup output for one channel with an empty shard. Overrides replace any field. */
export function channel_output(
  id: string,
  overrides: Partial<ChannelBackupOutput> = {},
): ChannelBackupOutput {
  return {
    shard: {
      format_version: 1,
      team_id: TEAM_ID,
      channel_id: id,
      channel: { id },
      members: [],
      tabs: [],
      read_mode: 'full',
      threads: {},
    },
    reused_entry: undefined,
    next_link: `link-${id}`,
    interrupted: false,
    failed_roots: {},
    hosted_recheck: {},
    errors: [],
    warnings: [],
    resumed_from_checkpoint: false,
    checkpoint: undefined,
    ...overrides,
  };
}

export interface PortOptions {
  readonly team?: TeamsGraphResource;
  /** Channels Graph lists for the team. Defaults to channel-1 and channel-2. */
  readonly channels?: TeamsGraphResource[];
  readonly previous?: TeamsSnapshotIndex;
  readonly unsupported_keys?: string[];
  readonly unreadable_keys?: string[];
  readonly cursors?: Record<string, TeamsChannelCursor>;
  readonly shards?: Record<string, TeamsChannelShard>;
  readonly failed_roots?: FailedItemLedger;
}

export interface Ports {
  readonly service: TeamsBackupService;
  /** Write and read calls in the order they happened: shard, index, cursor. */
  readonly order: string[];
  readonly connector: { get_team: Mock; list_team_members: Mock; list_channels: Mock };
  readonly indexes: { find_latest_readable: Mock; save: Mock };
  readonly shards: { load: Mock; save: Mock };
  readonly cursors: { load: Mock; save: Mock };
}

/** Builds the service with in-memory ports. Only the connector's team and channel calls are stubbed. */
export function make_ports(options: PortOptions = {}): Ports {
  const order: string[] = [];
  const tenant_ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const factory = { create: vi.fn(async () => tenant_ctx) } as unknown as TenantContextFactory;
  const connector = {
    get_team: vi.fn(async () => options.team ?? { id: TEAM_ID, displayName: 'Team' }),
    list_team_members: vi.fn(async () => []),
    list_channels: vi.fn(
      async () => options.channels ?? [{ id: 'channel-1' }, { id: 'channel-2' }],
    ),
  };
  const indexes = {
    find_latest_readable: vi.fn(async () => ({
      index: options.previous,
      unreadable_keys: options.unreadable_keys ?? [],
      unsupported_keys: options.unsupported_keys ?? [],
    })),
    save: vi.fn(async (_ctx: unknown, index: TeamsSnapshotIndex) => {
      order.push('index');
      return index;
    }),
  };
  const shards = {
    load: vi.fn(async (_ctx: unknown, key: string) => options.shards?.[key]),
    save: vi.fn(async (_ctx: unknown, shard: TeamsChannelShard) => {
      order.push(`shard:${shard.channel_id}`);
      return { storage_key: `shard-${shard.channel_id}`, checksum: 'sum', size_bytes: 1 };
    }),
  };
  const cursors = {
    load: vi.fn(
      async (_ctx: unknown, _team: string, channel_id: string) => options.cursors?.[channel_id],
    ),
    save: vi.fn(async (_ctx: unknown, cursor: TeamsChannelCursor) => {
      order.push(`cursor:${cursor.channel_id}`);
      return cursor;
    }),
  };
  const service = new TeamsBackupService(
    factory,
    connector as unknown as TeamsConnector,
    indexes as unknown as TeamsIndexRepository,
    shards as unknown as TeamsChannelShardRepository,
    cursors as unknown as TeamsChannelCursorRepository,
    new InMemoryTeamsChannelCheckpointRepository(),
    stub_owner_leases().leases,
  );
  return { service, order, connector, indexes, shards, cursors };
}
