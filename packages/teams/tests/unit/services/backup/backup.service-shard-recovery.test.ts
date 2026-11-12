import { describe, expect, it, vi } from 'vitest';
import {
  build_env,
  CHANNEL_ID,
  latest_shard,
  root,
  TEAM,
  TENANT,
  type Env,
} from './backup.service-storage-harness';
import { CHANNEL_WITH_EMAIL } from './channel-backup-processor-harness';
import { message } from './thread-store-harness';

const RECOVERY_COMMAND = `atlas teams backup --team ${TEAM} --channel ${CHANNEL_ID} --full`;

/** An environment whose channel has a delta link, backed up once so a shard and cursor exist. */
async function backed_up_env(): Promise<Env> {
  const env = build_env(CHANNEL_WITH_EMAIL, {
    list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })),
    fetch_message_delta_page: vi.fn(async () => ({ roots: [], delta_link: 'link-next' })),
  });
  const first = await env.service.backup_team(TENANT, TEAM);
  expect(first.summary.healthy).toBe(true);
  vi.mocked(env.connector.list_channel_messages_page).mockClear();
  vi.mocked(env.connector.fetch_message_delta_page).mockClear();
  return env;
}

/** The shard key the latest index names for the test channel. */
async function latest_shard_key(env: Env): Promise<string> {
  const { index } = await env.indexes.find_latest_readable(env.harness.ctx, TEAM);
  const entry = index?.channels.find((channel) => channel.channel_id === CHANNEL_ID);
  if (entry === undefined) throw new Error('channel missing from the latest index');
  return entry.shard_key;
}

/** Message reads, full or delta, the connector served since the last clear. */
function message_reads(env: Env): number {
  return (
    vi.mocked(env.connector.list_channel_messages_page).mock.calls.length +
    vi.mocked(env.connector.fetch_message_delta_page).mock.calls.length
  );
}

const DAMAGE = {
  missing: (env: Env, key: string) => env.harness.remove(key),
  corrupt: (env: Env, key: string) => env.harness.set_raw(key, Buffer.from('not a shard')),
};

describe.each(Object.entries(DAMAGE))('a %s previous shard (#708)', (_kind, damage) => {
  it('fails the channel without --full, names the recovery command, and reads nothing', async () => {
    const env = await backed_up_env();
    const key = await latest_shard_key(env);
    damage(env, key);

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain(key);
    expect(result.summary.errors[0]).toContain(RECOVERY_COMMAND);
    expect(message_reads(env)).toBe(0);
    expect(await latest_shard_key(env)).toBe(key);
  });

  it('rebuilds the channel in full under --full and leaves a readable latest shard', async () => {
    const env = await backed_up_env();
    const key = await latest_shard_key(env);
    damage(env, key);

    const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.warnings).toContainEqual(
      expect.stringContaining(`Channel ${CHANNEL_ID}: The Teams channel shard at ${key}`),
    );
    expect(result.summary.channels[0]).toMatchObject({ outcome: 'completed', read_mode: 'full' });
    expect(vi.mocked(env.connector.list_channel_messages_page)).toHaveBeenCalled();
    expect(Object.keys((await latest_shard(env)).threads)).toEqual(['m1']);
  });

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

  it('runs cleanly by delta on the run after the rebuild', async () => {
    const env = await backed_up_env();
    damage(env, await latest_shard_key(env));
    await env.service.backup_team(TENANT, TEAM, { force_full: true });
    vi.mocked(env.connector.list_channel_messages_page).mockClear();

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.warnings).toEqual([]);
    expect(vi.mocked(env.connector.fetch_message_delta_page)).toHaveBeenCalled();
    expect(vi.mocked(env.connector.list_channel_messages_page)).not.toHaveBeenCalled();
  });
});

describe('shard load failures that are not damage (#708)', () => {
  it('reports a storage error under --full as a failure and does not rebuild', async () => {
    const env = await backed_up_env();
    const key = await latest_shard_key(env);
    const get = env.harness.ctx.storage.get.bind(env.harness.ctx.storage);
    vi.spyOn(env.harness.ctx.storage, 'get').mockImplementation(async (requested: string) => {
      if (requested === key) throw new Error('connect ECONNRESET');
      return get(requested);
    });

    const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual([`Channel ${CHANNEL_ID}: connect ECONNRESET`]);
    expect(message_reads(env)).toBe(0);
    expect(await latest_shard_key(env)).toBe(key);
  });
});
