import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { S3TeamsManifestRepository } from '@/adapters/s3-teams-manifest-repository.adapter';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const OTHER_TEAM = '00000000-0000-0000-0000-000000000002';
const OLD_SNAPSHOT = 'teams-snap-1000-aaaaaa';
const NEW_SNAPSHOT = 'teams-snap-2000-bbbbbb';

/** Encrypts a manifest body the way the adapter stores it, under `store`'s key. */
function sealed(store: StubEncryptedObjectStore, team_id: string, snapshot_id: string): Buffer {
  const body = {
    team_id,
    snapshot_id,
    team_display_name: 'Team',
    created_at: '2025-01-01T00:00:00.000Z',
    channels: [],
  };
  return store.encrypt(Buffer.from(JSON.stringify(body), 'utf-8'));
}

/** Decrypts a sealed payload with `store`'s key. GCM authentication fails under any other key. */
function open_with(store: StubEncryptedObjectStore, payload: Buffer): Buffer {
  const decipher = store.create_decipher(payload.subarray(0, 12), payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

/** A context over an in-memory bucket of sealed manifests keyed by storage key. */
function make_ctx(store: StubEncryptedObjectStore, bodies: Record<string, Buffer>) {
  const get = vi.fn(async (key: string) => bodies[key]);
  const decrypt = vi.fn((payload: Buffer) => open_with(store, payload));
  const ctx = {
    storage: {
      exists: vi.fn(async (key: string) => key in bodies),
      list: vi.fn(async (prefix: string) =>
        Object.keys(bodies).filter((key) => key.startsWith(prefix)),
      ),
      get,
    },
    decrypt,
  } as unknown as TenantContext;
  return { ctx, get, decrypt };
}

describe('S3TeamsManifestRepository.find_latest_by_team', () => {
  it('decrypts only the newest snapshot even when an older one is listed first', async () => {
    const store = stub_encrypted_object_store();
    const old_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx, get } = make_ctx(store, {
      [old_key]: sealed(store, TEAM, OLD_SNAPSHOT),
      [new_key]: sealed(store, TEAM, NEW_SNAPSHOT),
    });

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest.manifest?.snapshot_id).toBe(NEW_SNAPSHOT);
    expect(latest.unreadable_keys).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(new_key);
  });

  it('returns no manifest and reads nothing for a team with no manifests', async () => {
    const store = stub_encrypted_object_store();
    const { ctx, get } = make_ctx(store, {});

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest).toEqual({ manifest: undefined, unreadable_keys: [] });
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the older readable manifest when the newest cannot be decrypted', async () => {
    const store = stub_encrypted_object_store();
    const other_store = stub_encrypted_object_store();
    const old_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx } = make_ctx(store, {
      [old_key]: sealed(store, TEAM, OLD_SNAPSHOT),
      [new_key]: sealed(other_store, TEAM, NEW_SNAPSHOT),
    });

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest.manifest?.snapshot_id).toBe(OLD_SNAPSHOT);
    expect(latest.unreadable_keys).toEqual([new_key]);
  });

  it('falls back when the newest body names a different snapshot than its key', async () => {
    const store = stub_encrypted_object_store();
    const old_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx } = make_ctx(store, {
      [old_key]: sealed(store, TEAM, OLD_SNAPSHOT),
      [new_key]: sealed(store, TEAM, OLD_SNAPSHOT),
    });

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest.manifest?.snapshot_id).toBe(OLD_SNAPSHOT);
    expect(latest.unreadable_keys).toEqual([new_key]);
  });

  it('reports every unreadable key and no manifest when none reads back', async () => {
    const store = stub_encrypted_object_store();
    const other_store = stub_encrypted_object_store();
    const old_key = TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT);
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx } = make_ctx(store, {
      [old_key]: sealed(other_store, TEAM, OLD_SNAPSHOT),
      [new_key]: sealed(other_store, TEAM, NEW_SNAPSHOT),
    });

    const latest = await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(latest.manifest).toBeUndefined();
    expect(latest.unreadable_keys).toEqual([new_key, old_key]);
  });

  it('binds each decrypt to the storage key it was read from', async () => {
    const store = stub_encrypted_object_store();
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx, decrypt } = make_ctx(store, {
      [new_key]: sealed(store, TEAM, NEW_SNAPSHOT),
    });

    await new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    expect(decrypt).toHaveBeenCalledWith(expect.any(Buffer), new_key);
  });

  it('rethrows a fetch failure as StorageError rather than treating the manifest as unreadable', async () => {
    const store = stub_encrypted_object_store();
    const new_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx, get } = make_ctx(store, { [new_key]: sealed(store, TEAM, NEW_SNAPSHOT) });
    get.mockRejectedValueOnce(new Error('connection reset'));

    const lookup = new S3TeamsManifestRepository().find_latest_by_team(ctx, TEAM);

    await expect(lookup).rejects.toBeInstanceOf(StorageError);
    await expect(lookup).rejects.not.toBeInstanceOf(UnreadableContentError);
  });
});

describe('S3TeamsManifestRepository.list_latest_per_team', () => {
  it('returns the newest readable manifest per team, with undefined for an all-unreadable team', async () => {
    const store = stub_encrypted_object_store();
    const other_store = stub_encrypted_object_store();
    const { ctx } = make_ctx(store, {
      [TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT)]: sealed(store, TEAM, OLD_SNAPSHOT),
      [TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT)]: sealed(store, TEAM, NEW_SNAPSHOT),
      [TEAMS_KEYS.manifest_key(OTHER_TEAM, OLD_SNAPSHOT)]: sealed(
        other_store,
        OTHER_TEAM,
        OLD_SNAPSHOT,
      ),
    });

    const latest = await new S3TeamsManifestRepository().list_latest_per_team(ctx);

    expect(
      Object.fromEntries(latest.map((row) => [row.team_id, row.manifest?.snapshot_id])),
    ).toEqual({ [TEAM]: NEW_SNAPSHOT, [OTHER_TEAM]: undefined });
  });
});

describe('S3TeamsManifestRepository full listings', () => {
  it('throws UnreadableContentError naming the key when any manifest of the team is corrupt', async () => {
    const store = stub_encrypted_object_store();
    const other_store = stub_encrypted_object_store();
    const bad_key = TEAMS_KEYS.manifest_key(TEAM, NEW_SNAPSHOT);
    const { ctx } = make_ctx(store, {
      [TEAMS_KEYS.manifest_key(TEAM, OLD_SNAPSHOT)]: sealed(store, TEAM, OLD_SNAPSHOT),
      [bad_key]: sealed(other_store, TEAM, NEW_SNAPSHOT),
    });

    const listing = new S3TeamsManifestRepository().list_snapshots_by_team(ctx, TEAM);

    await expect(listing).rejects.toBeInstanceOf(UnreadableContentError);
    await expect(listing).rejects.toThrow(bad_key);
  });
});
