import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsupportedFormatVersionError, type TeamsGraphResource } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  build_env,
  CHANNEL,
  CHANNEL_ID,
  latest_shard,
  root,
  stored_cursor,
  TEAM,
  TENANT,
  type Env,
} from './backup.service-storage-harness';
import { message } from './thread-store-harness';

const RECOVERY_COMMAND = `atlas teams backup --team ${TEAM} --channel ${CHANNEL_ID} --full`;

/** An env whose channel lists `listed.roots` on every full read, after one completed first run. */
async function env_after_first_run(listed: { roots: TeamsGraphResource[] }): Promise<Env> {
  const env = build_env(CHANNEL, {
    list_channel_messages_page: vi.fn(async () => ({ roots: listed.roots.map(root) })),
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

/** The two ways issue #708 loses a shard: the object is gone, or its bytes no longer decrypt. */
const LOSSES = [
  ['missing', (env: Env, key: string): void => env.harness.remove(key)],
  [
    'damaged',
    (env: Env, key: string): void => env.harness.set_raw(key, Buffer.from('not a shard')),
  ],
] as const;

describe('TeamsBackupService with an unreadable previous channel shard (issue #708)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(LOSSES)(
    'without --full fails the channel on a %s shard and names the recovery command',
    async (_label, lose) => {
      const env = await env_after_first_run({ roots: [message('m1')] });
      const lost_key = await latest_shard_key(env);
      lose(env, lost_key);
      const lost_bytes = env.harness.raw(lost_key);

      const result = await env.service.backup_team(TENANT, TEAM);

      expect(result.summary.healthy).toBe(false);
      expect(result.summary.errors).toHaveLength(1);
      expect(result.summary.errors[0]).toContain(lost_key);
      expect(result.summary.errors[0]).toContain(RECOVERY_COMMAND);
      expect(env.harness.raw(lost_key)).toEqual(lost_bytes);
      expect(await latest_shard_key(env)).toBe(lost_key);
    },
  );

  it.each(LOSSES)(
    'with --full rebuilds a %s shard, warns with its key, and replaces the object',
    async (_label, lose) => {
      const env = await env_after_first_run({ roots: [message('m1')] });
      const lost_key = await latest_shard_key(env);
      lose(env, lost_key);

      const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

      expect(result.summary.errors).toEqual([]);
      expect(result.summary.healthy).toBe(true);
      expect(result.summary.warnings.filter((w) => w.includes(lost_key))).toHaveLength(1);
      // The rebuilt content is identical, so it lands on the lost key and has to be written there.
      expect(await latest_shard_key(env)).toBe(lost_key);
      expect(Object.keys((await latest_shard(env)).threads)).toEqual(['m1']);
      expect((await stored_cursor(env))?.baseline_shard_key).toBe(lost_key);
    },
  );

  it.each(LOSSES)(
    'with --full writes a new shard and index entry when the channel changed since the %s shard',
    async (_label, lose) => {
      const listed = { roots: [message('m1'), message('m2')] };
      const env = await env_after_first_run(listed);
      const lost_key = await latest_shard_key(env);
      lose(env, lost_key);
      listed.roots = [message('m2'), message('m3')];

      const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

      expect(result.summary.healthy).toBe(true);
      expect(await latest_shard_key(env)).not.toBe(lost_key);
      expect(Object.keys((await latest_shard(env)).threads).sort()).toEqual(['m2', 'm3']);
    },
  );

  it('reads cleanly without --full on the run after the rebuild', async () => {
    const env = await env_after_first_run({ roots: [message('m1')] });
    env.harness.set_raw(await latest_shard_key(env), Buffer.from('not a shard'));
    await env.service.backup_team(TENANT, TEAM, { force_full: true });

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.warnings).toEqual([]);
  });

  it('with --full reports a storage error loading the shard and rebuilds nothing', async () => {
    const env = await env_after_first_run({ roots: [message('m1')] });
    const shard_key = await latest_shard_key(env);
    const get = env.harness.ctx.storage.get.bind(env.harness.ctx.storage);
    vi.spyOn(env.harness.ctx.storage, 'get').mockImplementation(async (key) => {
      if (key === shard_key) throw new Error('connection reset');
      return get(key);
    });
    const put = vi.spyOn(env.harness.ctx.storage, 'put');

    const result = await env.service.backup_team(TENANT, TEAM, { force_full: true });

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual([`Channel ${CHANNEL_ID}: connection reset`]);
    expect(put.mock.calls.map((call) => call[0])).not.toContain(shard_key);
  });

  it('with --full still stops the run when the previous shard was written by a newer format', async () => {
    const env = await env_after_first_run({ roots: [message('m1')] });
    const before = env.harness.keys();
    vi.spyOn(env.shards, 'load').mockRejectedValue(
      new UnsupportedFormatVersionError('shard written by a newer version'),
    );

    await expect(
      env.service.backup_team(TENANT, TEAM, { force_full: true }),
    ).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
    expect(env.harness.keys()).toEqual(before);
  });
});
