import { describe, expect, it, vi } from 'vitest';
import {
  build_env,
  CHANNEL_ID,
  root,
  TEAM,
  TENANT,
  type Env,
} from './backup.service-storage-harness';
import { CHANNEL_WITH_EMAIL } from './channel-backup-processor-harness';
import { message } from './thread-store-harness';

/** An environment whose channel has a delta link, backed up once so a shard and cursor exist. */
async function backed_up_env(): Promise<Env> {
  const env = build_env(CHANNEL_WITH_EMAIL, {
    list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
    fetch_message_delta_page: vi.fn(async () => ({ roots: [], delta_link: 'link-next' })),
  });
  const first = await env.service.backup_team(TENANT, TEAM);
  expect(first.summary.healthy).toBe(true);
  return env;
}

/** The shard key the latest index names for the test channel. */
async function latest_shard_key(env: Env): Promise<string> {
  const { index } = await env.indexes.find_latest_readable(env.harness.ctx, TEAM);
  const entry = index?.channels.find((channel) => channel.channel_id === CHANNEL_ID);
  if (entry === undefined) throw new Error('channel missing from the latest index');
  return entry.shard_key;
}

const DAMAGE = {
  missing: (env: Env, key: string) => env.harness.remove(key),
  corrupt: (env: Env, key: string) => env.harness.set_raw(key, Buffer.from('not a shard')),
};

describe.each(Object.entries(DAMAGE))('a --full rebuild of a %s shard (#708)', (_kind, damage) => {
  it('reports identical rebuilt content as repaired in place, not as no changes', async () => {
    const env = await backed_up_env();
    const key = await latest_shard_key(env);
    damage(env, key);

    const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

    expect(result.summary.healthy).toBe(true);
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.repaired_shard_keys).toEqual([key]);
    expect(await latest_shard_key(env)).toBe(key);
  });

  it('records a rebuild with new content as a new snapshot, not as an in-place repair', async () => {
    const env = await backed_up_env();
    const key = await latest_shard_key(env);
    damage(env, key);
    vi.mocked(env.connector.list_channel_messages_page).mockResolvedValue({
      roots: [root(message('m1')), root(message('m2'))],
    });

    const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

    expect(result.summary.healthy).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.summary.repaired_shard_keys).toBeUndefined();
    expect(await latest_shard_key(env)).not.toBe(key);
  });
});

describe('a run without damage (#708)', () => {
  it('reports no repaired shards', async () => {
    const env = await backed_up_env();

    const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

    expect(result.summary.repaired_shard_keys).toBeUndefined();
  });
});
