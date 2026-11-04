import { describe, expect, it, vi } from 'vitest';
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
import { S3TeamsChannelCursorRepository } from '@/adapters/s3-teams-channel-cursor-repository.adapter';
import { S3TeamsChannelShardRepository } from '@/adapters/s3-teams-channel-shard-repository.adapter';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';
import { TeamsBackupService } from '@/services/backup/backup.service';
import {
  TEAMS_KEYS,
  teams_cursor_key,
  teams_shard_prefix_for,
} from '@/services/shared/storage-keys';
import { CHANNEL_WITH_EMAIL, make_connector } from './channel-backup-processor-harness';
import { hosted_body, message } from './thread-store-harness';

const TENANT = 'tenant-test';
const TEAM = '00000000-0000-0000-0000-000000000042';
const CHANNEL: TeamsGraphResource = { id: 'channel-1', displayName: 'General' };
const CHANNEL_ID = 'channel-1';
const CHANGE_AT = '2025-01-02T00:00:00.000Z';

interface Env {
  readonly harness: InMemoryTenantContext;
  readonly service: TeamsBackupService;
  readonly connector: TeamsConnector;
  readonly indexes: S3TeamsIndexRepository;
  readonly shards: S3TeamsChannelShardRepository;
  readonly cursors: S3TeamsChannelCursorRepository;
}

/** A service over real index, shard and cursor adapters and in-memory storage. */
function build_env(channel: TeamsGraphResource, overrides: Partial<TeamsConnector>): Env {
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
  const service = new TeamsBackupService(factory, connector, indexes, shards, cursors);
  return { harness, service, connector, indexes, shards, cursors };
}

/** A root change as a full channel read returns it. */
function root(root_message: TeamsGraphResource): TeamsRootChange {
  return { root: root_message, deleted: false };
}

/** The shard the latest index points at for the test channel. */
async function latest_shard(env: Env): Promise<TeamsChannelShard> {
  const { index } = await env.indexes.find_latest_readable(env.harness.ctx, TEAM);
  const entry = index?.channels.find((channel) => channel.channel_id === CHANNEL_ID);
  if (entry === undefined) throw new Error('channel missing from the latest index');
  const shard = await env.shards.load(env.harness.ctx, entry.shard_key);
  if (shard === undefined) throw new Error('shard missing from storage');
  return shard;
}

/** The stored cursor of the test channel, or undefined when none was saved. */
async function stored_cursor(env: Env): Promise<TeamsChannelCursor | undefined> {
  return env.cursors.load(env.harness.ctx, TEAM, CHANNEL_ID);
}

/** Keys present after a run that were absent before it. */
function added_keys(before: string[], after: string[]): string[] {
  return after.filter((key) => !before.includes(key));
}

describe('TeamsBackupService over the real storage adapters', () => {
  it('first run writes one index, one shard and one cursor', async () => {
    const env = build_env(CHANNEL, {
      list_channel_messages: vi.fn(async () => [root(message('m1'))]),
    });

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect(Object.keys((await latest_shard(env)).threads)).toEqual(['m1']);
    expect(env.harness.keys()).toContain(teams_cursor_key(TEAM, CHANNEL_ID));
  });

  it('unchanged run writes only the cursor', async () => {
    const env = build_env(CHANNEL, {
      list_channel_messages: vi.fn(async () => [root(message('m1'))]),
    });
    await env.service.backup_team(TENANT, TEAM);
    const put = vi.spyOn(env.harness.ctx.storage, 'put');

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(true);
    expect(put.mock.calls.map((call) => call[0])).toEqual([teams_cursor_key(TEAM, CHANNEL_ID)]);
  });

  it('a changed reply adds one data blob, one shard and one index', async () => {
    let reply_text = 'first';
    const env = build_env(CHANNEL, {
      list_channel_messages: vi.fn(async () => [root(message('m1'))]),
      list_replies: vi.fn(async () => [
        message('r1', { replyToId: 'm1', body: { contentType: 'html', content: reply_text } }),
      ]),
    });
    await env.service.backup_team(TENANT, TEAM);
    const before = env.harness.keys();
    reply_text = 'edited';

    const result = await env.service.backup_team(TENANT, TEAM);
    const added = added_keys(before, env.harness.keys());

    expect(result.summary.healthy).toBe(true);
    expect(added.filter((key) => key.startsWith(TEAMS_KEYS.data_prefix_for(TEAM)))).toHaveLength(1);
    expect(added.filter((key) => key.startsWith(teams_shard_prefix_for(TEAM)))).toHaveLength(1);
    expect(
      added.filter((key) => key.startsWith(TEAMS_KEYS.manifest_prefix_for(TEAM))),
    ).toHaveLength(1);
    expect(added).toHaveLength(3);
  });

  it('a cancel mid-channel records no ledger attempt and reports interrupted', async () => {
    let stopped = false;
    const env = build_env(CHANNEL, {
      list_channel_messages: vi.fn(async () => [root(message('m1'))]),
      list_replies: vi.fn(async () => {
        stopped = true;
        throw new Error('cancelled by the operator');
      }),
    });

    const result = await env.service.backup_team(TENANT, TEAM, {
      should_interrupt: () => stopped,
    });

    expect(result.interrupted).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect((await stored_cursor(env))?.failed_roots ?? {}).toEqual({});
  });

  it('a 404 on re-read keeps the stored root and records an attempt', async () => {
    let fail_replies = false;
    let delta_roots: TeamsRootChange[] = [];
    const get_channel_message = vi.fn(async () => ({ status: 'not_found' as const }));
    const env = build_env(CHANNEL_WITH_EMAIL, {
      list_channel_messages: vi.fn(async () => [root(message('m1'))]),
      fetch_message_delta: vi.fn(async () => ({ roots: delta_roots, delta_link: 'link-next' })),
      list_replies: vi.fn(async () => {
        if (fail_replies) throw new Error('transient reply failure');
        return [];
      }),
      get_channel_message,
    });
    await env.service.backup_team(TENANT, TEAM);

    fail_replies = true;
    delta_roots = [root(message('m1', { lastModifiedDateTime: CHANGE_AT }))];
    await env.service.backup_team(TENANT, TEAM);
    expect((await stored_cursor(env))?.failed_roots?.m1?.attempts).toBe(1);

    fail_replies = false;
    delta_roots = [];
    const result = await env.service.backup_team(TENANT, TEAM);

    expect(get_channel_message).toHaveBeenCalledWith(TENANT, TEAM, CHANNEL_ID, 'm1');
    expect((await stored_cursor(env))?.failed_roots?.m1?.attempts).toBe(2);
    const thread = (await latest_shard(env)).threads.m1;
    expect(thread).toBeDefined();
    expect(thread?.deleted_at).toBeUndefined();
    expect(result.summary.errors).toEqual([]);
  });

  it('a delta channel rechecks a root whose hosted content was missing', async () => {
    let hosted_available = false;
    const hosted_root = message('m1', {
      body: { contentType: 'html', content: hosted_body('m1', 'h1') },
    });
    const download_hosted_content = vi.fn(async () => {
      if (!hosted_available) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { bytes: Buffer.from('png'), content_type: 'image/png' };
    });
    const env = build_env(CHANNEL_WITH_EMAIL, {
      list_channel_messages: vi.fn(async () => [root(hosted_root)]),
      fetch_message_delta: vi.fn(async () => ({ roots: [], delta_link: 'link-next' })),
      get_channel_message: vi.fn(async () => ({
        status: 'found' as const,
        change: root(hosted_root),
      })),
      list_hosted_contents: vi.fn(async () => [{ id: 'h1' }]),
      download_hosted_content,
    });

    await env.service.backup_team(TENANT, TEAM);
    expect((await stored_cursor(env))?.hosted_recheck).toEqual({ m1: 1 });
    expect((await latest_shard(env)).threads.m1?.root.hosted_missing).toEqual(['h1']);

    hosted_available = true;
    await env.service.backup_team(TENANT, TEAM);

    expect((await stored_cursor(env))?.hosted_recheck ?? {}).toEqual({});
    expect((await latest_shard(env)).threads.m1?.root.hosted_missing).toBeUndefined();
    expect(download_hosted_content).toHaveBeenCalledTimes(2);
  });
});
