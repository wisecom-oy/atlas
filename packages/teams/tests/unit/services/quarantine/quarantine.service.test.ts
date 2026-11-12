import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { TeamsSnapshotIndex, TenantContextFactory } from '@wisecom/atlas-types';
import { NotFoundError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';
import { TeamsQuarantineService } from '@/services/quarantine/quarantine.service';
import {
  teams_channel_shard_key,
  teams_cursor_key,
  TEAMS_KEYS,
} from '@/services/shared/storage-keys';

const TEAM = 'aaaaaaaa-1111-2222-3333-444444444444';
const OLD_SNAPSHOT = 'teams-snap-1000-aaaaaa';
const NEW_SNAPSHOT = 'teams-snap-2000-bbbbbb';
const OLD_KEY = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
const NEW_KEY = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);

function index(snapshot_id: string, created_ms: number): TeamsSnapshotIndex {
  return {
    id: snapshot_id,
    format_version: 1,
    tenant_id: 'tenant-test',
    team_id: TEAM,
    snapshot_id,
    created_at: new Date(created_ms),
    team: {},
    members: [],
    channels: [],
    totals: { thread_count: 0, message_count: 0, size_bytes: 0 },
  } as unknown as TeamsSnapshotIndex;
}

/** Two healthy indexes of one team, with the newer one damaged on request. */
async function rig() {
  const harness = in_memory_tenant_context();
  const indexes = new S3TeamsIndexRepository();
  await indexes.save(harness.ctx, index(OLD_SNAPSHOT, 1000));
  await indexes.save(harness.ctx, index(NEW_SNAPSHOT, 2000));
  const factory = { create: async () => harness.ctx } as unknown as TenantContextFactory;
  const service = new TeamsQuarantineService(factory, indexes);
  const damage = (key: string, bytes = Buffer.from('garbage')): void => harness.set_raw(key, bytes);
  return { harness, indexes, service, damage };
}

describe('TeamsQuarantineService (issue #694)', () => {
  it('moves a damaged index aside with its bytes unchanged, so the older one is the baseline', async () => {
    const { harness, indexes, service, damage } = await rig();
    damage(NEW_KEY);

    const result = await service.quarantine_unreadable_object('tenant-test', NEW_KEY);

    expect(result).toMatchObject({
      storage_key: NEW_KEY,
      quarantine_key: `_quarantine/${NEW_KEY}`,
      kind: 'manifest',
    });
    expect(harness.raw(NEW_KEY)).toBeUndefined();
    expect(harness.raw(`_quarantine/${NEW_KEY}`)).toEqual(Buffer.from('garbage'));
    const latest = await indexes.find_latest_readable(harness.ctx, TEAM);
    expect(latest).toMatchObject({
      index: { snapshot_id: OLD_SNAPSHOT },
      unreadable_keys: [],
      unsupported_keys: [],
    });
  });

  it('moves an index whose body names another snapshot', async () => {
    const { harness, service } = await rig();
    // A healthy ciphertext copied under another key fails its key-bound decrypt.
    harness.set_raw(NEW_KEY, harness.raw(OLD_KEY) ?? Buffer.alloc(0));

    await expect(
      service.quarantine_unreadable_object('tenant-test', NEW_KEY),
    ).resolves.toMatchObject({ quarantine_key: `_quarantine/${NEW_KEY}` });
  });

  it('refuses an index that reads cleanly and leaves it in place', async () => {
    const { harness, service } = await rig();
    const before = harness.keys();

    await expect(service.quarantine_unreadable_object('tenant-test', NEW_KEY)).rejects.toThrow(
      /reads cleanly/,
    );
    expect(harness.keys()).toEqual(before);
  });

  it('refuses a key with nothing stored', async () => {
    const { service } = await rig();
    const absent = TEAMS_KEYS.manifest_key(TEAM, 'teams-snap-3000-cccccc');

    await expect(
      service.quarantine_unreadable_object('tenant-test', absent),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a newer-format index and keeps it', async () => {
    const { harness, service } = await rig();
    const newer = { ...index(NEW_SNAPSHOT, 2000), format_version: 99 };
    harness.set_raw(NEW_KEY, harness.ctx.encrypt(Buffer.from(JSON.stringify(newer)), NEW_KEY));

    await expect(
      service.quarantine_unreadable_object('tenant-test', NEW_KEY),
    ).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
    expect(harness.raw(NEW_KEY)).toBeDefined();
    expect(harness.raw(`_quarantine/${NEW_KEY}`)).toBeUndefined();
  });

  it.each([
    ['a channel cursor', teams_cursor_key(TEAM, 'channel-1')],
    ['a channel shard', teams_channel_shard_key(TEAM, 'channel-1', 'shard-name')],
    ['an uppercase team segment Atlas never writes', NEW_KEY.replace(TEAM, TEAM.toUpperCase())],
    ['a path traversal', `teams/manifests/${TEAM}/../${NEW_SNAPSHOT}.json`],
    ['another workload', `onedrive/manifests/${TEAM}/${NEW_SNAPSHOT}.json`],
  ])('refuses %s, which is outside the index layout', async (_label, key) => {
    const { harness, service, damage } = await rig();
    damage(key);

    await expect(service.quarantine_unreadable_object('tenant-test', key)).rejects.toThrow(
      /Only Teams snapshot indexes can be quarantined/,
    );
    expect(harness.raw(`_quarantine/${key}`)).toBeUndefined();
  });
});
