import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';
import { teams_channel_shard_key, TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const OTHER_TEAM = '00000000-0000-0000-0000-000000000002';
const OLD_SNAPSHOT = 'teams-snap-1000-aaaaaa';
const NEW_SNAPSHOT = 'teams-snap-2000-bbbbbb';

/** Encrypts an index body the way the adapter stores it, under `store`'s key. */
function sealed(
  store: StubEncryptedObjectStore,
  team_id: string,
  snapshot_id: string,
  extra: Record<string, unknown> = {},
): Buffer {
  const body = {
    format_version: 1,
    team_id,
    snapshot_id,
    created_at: '2025-01-01T00:00:00.000Z',
    channels: [],
    ...extra,
  };
  return store.encrypt(Buffer.from(JSON.stringify(body), 'utf-8'));
}

/** A context over an in-memory bucket of sealed objects keyed by storage key. */
function make_ctx(store: StubEncryptedObjectStore, bodies: Record<string, Buffer>) {
  const get = vi.fn(async (key: string) => bodies[key]);
  const ctx = {
    storage: {
      list: vi.fn(async (prefix: string) =>
        Object.keys(bodies).filter((key) => key.startsWith(prefix)),
      ),
      exists: vi.fn(async (key: string) => key in bodies),
      get,
    },
    decrypt: vi.fn((payload: Buffer) => store.decrypt(payload)),
  } as unknown as TenantContext;
  return { ctx, get };
}

describe('S3TeamsIndexRepository.list_teams', () => {
  it('groups indexes by team and reports unsupported and unreadable keys apart (N1)', async () => {
    const store = stub_encrypted_object_store();
    const newer_format = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const damaged = TEAMS_KEYS.manifest_key(OTHER_TEAM, OLD_SNAPSHOT);
    const { ctx } = make_ctx(store, {
      [TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT)]: sealed(store, TEAM, OLD_SNAPSHOT),
      [newer_format]: sealed(store, TEAM, NEW_SNAPSHOT, { format_version: 2 }),
      [damaged]: sealed(store, OTHER_TEAM, NEW_SNAPSHOT),
    });

    const teams = await new S3TeamsIndexRepository().list_teams(ctx);

    const by_team = Object.fromEntries(teams.map((entry) => [entry.team_id, entry.listing]));
    expect(by_team[TEAM]).toMatchObject({
      indexes: [{ snapshot_id: OLD_SNAPSHOT }],
      unreadable_keys: [],
      unsupported_keys: [newer_format],
    });
    expect(by_team[OTHER_TEAM]).toMatchObject({
      indexes: [],
      unreadable_keys: [damaged],
      unsupported_keys: [],
    });
  });

  it('never reads channel shards as indexes (N2)', async () => {
    const store = stub_encrypted_object_store();
    const shard = teams_channel_shard_key(TEAM, 'channel-1', 'shard-name');
    const { ctx, get } = make_ctx(store, {
      [TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT)]: sealed(store, TEAM, OLD_SNAPSHOT),
      [shard]: store.encrypt(Buffer.from('not an index')),
    });

    const teams = await new S3TeamsIndexRepository().list_teams(ctx);

    expect(teams[0]?.listing.unreadable_keys).toEqual([]);
    expect(get).not.toHaveBeenCalledWith(shard);
  });
});

describe('S3TeamsIndexRepository.find_by_snapshot', () => {
  it('returns undefined without fetching when the snapshot is absent', async () => {
    const store = stub_encrypted_object_store();
    const { ctx, get } = make_ctx(store, {});

    const index = await new S3TeamsIndexRepository().find_by_snapshot(ctx, TEAM, NEW_SNAPSHOT);

    expect(index).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('S3TeamsIndexRepository.find_latest_readable', () => {
  const NEWEST_SNAPSHOT = 'teams-snap-3000-cccccc';

  it('stops at the newest readable index and never downloads older ones', async () => {
    const store = stub_encrypted_object_store();
    const older_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const { ctx, get } = make_ctx(store, {
      [older_key]: sealed(store, TEAM, OLD_SNAPSHOT),
      [TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT)]: sealed(store, TEAM, NEW_SNAPSHOT),
      [TEAMS_KEYS.manifest_key(TEAM, NEWEST_SNAPSHOT)]: sealed(store, TEAM, NEWEST_SNAPSHOT),
    });

    const latest = await new S3TeamsIndexRepository().find_latest_readable(ctx, TEAM);

    expect(latest).toMatchObject({
      index: { snapshot_id: NEWEST_SNAPSHOT },
      unreadable_keys: [],
      unsupported_keys: [],
    });
    expect(get).not.toHaveBeenCalledWith(older_key);
  });

  it('reports damaged and newer-format indexes newer than the one returned', async () => {
    const store = stub_encrypted_object_store();
    const newest_key = TEAMS_KEYS.manifest_key(TEAM, NEWEST_SNAPSHOT);
    const damaged_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const older_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const { ctx, get } = make_ctx(store, {
      [newest_key]: sealed(store, TEAM, NEWEST_SNAPSHOT, { format_version: 2 }),
      [damaged_key]: sealed(store, OTHER_TEAM, NEW_SNAPSHOT),
      [older_key]: sealed(store, TEAM, OLD_SNAPSHOT),
    });

    const latest = await new S3TeamsIndexRepository().find_latest_readable(ctx, TEAM);

    expect(latest).toMatchObject({
      index: { snapshot_id: OLD_SNAPSHOT },
      unreadable_keys: [damaged_key],
      unsupported_keys: [newest_key],
    });
    expect(get).toHaveBeenCalledWith(damaged_key);
    expect(get).toHaveBeenCalledWith(older_key);
  });
});
