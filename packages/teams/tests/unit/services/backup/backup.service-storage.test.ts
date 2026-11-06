import { describe, expect, it, vi } from 'vitest';
import type { TeamsRootChange } from '@wisecom/atlas-types';
import {
  TEAMS_KEYS,
  teams_cursor_key,
  teams_shard_prefix_for,
} from '@/services/shared/storage-keys';
import {
  added_keys,
  build_env,
  CHANNEL,
  CHANNEL_ID,
  latest_shard,
  root,
  stored_cursor,
  TEAM,
  TENANT,
} from './backup.service-storage-harness';
import { CHANNEL_WITH_EMAIL } from './channel-backup-processor-harness';
import { hosted_body, message } from './thread-store-harness';

const CHANGE_AT = '2025-01-02T00:00:00.000Z';

describe('TeamsBackupService over the real storage adapters', () => {
  it('first run writes one index, one shard and one cursor', async () => {
    const env = build_env(CHANNEL, {
      list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
    });

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect(Object.keys((await latest_shard(env)).threads)).toEqual(['m1']);
    expect(env.harness.keys()).toContain(teams_cursor_key(TEAM, CHANNEL_ID));
  });

  it('unchanged run writes only the cursor', async () => {
    const env = build_env(CHANNEL, {
      list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
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
      list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
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
      list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
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
      list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
      fetch_message_delta_page: vi.fn(async () => ({
        roots: delta_roots,
        delta_link: 'link-next',
      })),
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
      list_channel_messages_page: vi.fn(async () => ({ roots: [root(hosted_root)] })),
      fetch_message_delta_page: vi.fn(async () => ({ roots: [], delta_link: 'link-next' })),
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
