import { vi } from 'vitest';
import type {
  TeamsChannelCursor,
  TeamsChannelShard,
  TeamsConnector,
  TeamsGraphResource,
  TeamsRootChange,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import { S3TeamsChannelCursorRepository } from '@/adapters/s3-teams-channel-cursor-repository.adapter';
import { S3TeamsChannelShardRepository } from '@/adapters/s3-teams-channel-shard-repository.adapter';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';
import { TeamsBackupService } from '@/services/backup/backup.service';
import { make_connector } from './channel-backup-processor-harness';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

export const TENANT = 'tenant-test';
export const TEAM = '00000000-0000-0000-0000-000000000042';
export const CHANNEL: TeamsGraphResource = { id: 'channel-1', displayName: 'General' };
export const CHANNEL_ID = 'channel-1';

export interface Env {
  readonly harness: InMemoryTenantContext;
  readonly service: TeamsBackupService;
  readonly connector: TeamsConnector;
  readonly indexes: S3TeamsIndexRepository;
  readonly shards: S3TeamsChannelShardRepository;
  readonly cursors: S3TeamsChannelCursorRepository;
}

/** A service over real index, shard and cursor adapters and in-memory storage. */
export function build_env(channel: TeamsGraphResource, overrides: Partial<TeamsConnector>): Env {
  const harness = in_memory_tenant_context(TENANT);
  const factory = { create: vi.fn(async () => harness.ctx) } as unknown as TenantContextFactory;
  const connector = make_connector({
    get_team: vi.fn(async () => ({ id: TEAM, displayName: 'Team' })),
    list_team_members: vi.fn(async () => []),
    list_channels: vi.fn(async () => [channel]),
    ...overrides,
  });
  const indexes = new S3TeamsIndexRepository();
  const shards = new S3TeamsChannelShardRepository();
  const cursors = new S3TeamsChannelCursorRepository();
  const service = new TeamsBackupService(
    factory,
    connector,
    indexes,
    shards,
    cursors,
    new InMemoryTeamsChannelCheckpointRepository(),
    stub_owner_leases().leases,
  );
  return { harness, service, connector, indexes, shards, cursors };
}

/** A root change as a full channel read returns it. */
export function root(root_message: TeamsGraphResource): TeamsRootChange {
  return { root: root_message, deleted: false };
}

/** The shard the latest index points at for the test channel. */
export async function latest_shard(env: Env): Promise<TeamsChannelShard> {
  const { index } = await env.indexes.find_latest_readable(env.harness.ctx, TEAM);
  const entry = index?.channels.find((channel) => channel.channel_id === CHANNEL_ID);
  if (entry === undefined) throw new Error('channel missing from the latest index');
  const shard = await env.shards.load(env.harness.ctx, entry.shard_key);
  if (shard === undefined) throw new Error('shard missing from storage');
  return shard;
}

/** The stored cursor of the test channel, or undefined when none was saved. */
export async function stored_cursor(env: Env): Promise<TeamsChannelCursor | undefined> {
  return env.cursors.load(env.harness.ctx, TEAM, CHANNEL_ID);
}

/** Keys present after a run that were absent before it. */
export function added_keys(before: string[], after: string[]): string[] {
  return after.filter((key) => !before.includes(key));
}
