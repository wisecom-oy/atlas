import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  TeamsChannelShard,
  TeamsChannelShardRepository,
  TeamsIndexRepository,
  TeamsMessageRef,
  TeamsSnapshotIndex,
  TeamsStoredBlobRef,
  TeamsThread,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { NotFoundError, UnreadableContentError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { TeamsVerificationService } from '@/services/verification/verification.service';

const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const SNAPSHOT = 'teams-snap-2000-bbbbbb';
const SHARD_KEY = `teams/manifests/${TEAM}/channels/channel-1/shard-name.json`;
const TIMESTAMP = '2025-01-01T00:00:00.000Z';

/** Stores one sealed blob in `bucket` and returns the reference an index or shard would record. */
function put_blob(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  storage_key: string,
  plaintext: string,
): TeamsStoredBlobRef {
  const bytes = Buffer.from(plaintext, 'utf-8');
  bucket.set(storage_key, store.encrypt(bytes));
  return {
    storage_key,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

function message(own: TeamsStoredBlobRef, extra: Partial<TeamsMessageRef> = {}): TeamsMessageRef {
  return { ...own, last_modified_at: TIMESTAMP, hosted: {}, ...extra };
}

function thread(root: TeamsMessageRef): TeamsThread {
  return { root, replies: {} };
}

function shard_with(threads: Record<string, TeamsThread>): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: 'channel-1',
    channel: { id: 'channel-1' },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads,
  };
}

function index_listing(shard_key: string): TeamsSnapshotIndex {
  return {
    id: `${TEAM}-${SNAPSHOT}`,
    format_version: 1,
    tenant_id: 'tenant',
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    created_at: new Date(TIMESTAMP),
    team: { id: TEAM },
    members: [],
    channels: [
      {
        channel_id: 'channel-1',
        shard_key,
        shard_checksum: 'unused',
        thread_count: 1,
        message_count: 1,
        size_bytes: 0,
      },
    ],
    totals: { thread_count: 1, message_count: 1, size_bytes: 0 },
  };
}

/**
 * Builds the service over an in-memory bucket. `shards` maps a shard key to the shard `load`
 * returns; a key that is in the bucket but not in `shards` makes `load` throw as a corrupt shard.
 */
function setup(
  store: StubEncryptedObjectStore,
  bucket: Map<string, Buffer>,
  shards: Map<string, TeamsChannelShard> = new Map(),
) {
  const get = vi.fn(async (key: string) => {
    const body = bucket.get(key);
    if (body === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    return body;
  });
  const ctx = {
    storage: { exists: vi.fn(async (key: string) => bucket.has(key)), get },
    decrypt: (payload: Buffer) => store.decrypt(payload),
    create_content_hmac: () => stub_tenant_create_content_hmac(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const find_by_snapshot = vi.fn<TeamsIndexRepository['find_by_snapshot']>();
  const load = vi.fn(async (_ctx: TenantContext, key: string) => {
    const shard = shards.get(key);
    if (shard === undefined) throw new UnreadableContentError(`corrupt shard ${key}`);
    return shard;
  });
  const service = new TeamsVerificationService(
    { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory,
    { find_by_snapshot } as unknown as TeamsIndexRepository,
    { load } as unknown as TeamsChannelShardRepository,
  );
  return { get, find_by_snapshot, service };
}

/** Stores a shard object in the bucket and makes `load` return `content` for its key. */
function put_shard(
  bucket: Map<string, Buffer>,
  store: StubEncryptedObjectStore,
  shards: Map<string, TeamsChannelShard>,
  content: TeamsChannelShard,
): void {
  bucket.set(SHARD_KEY, store.encrypt(Buffer.from('shard bytes')));
  shards.set(SHARD_KEY, content);
}

describe('TeamsVerificationService.verify_teams_snapshot', () => {
  it('passes when the shard and every referenced blob match', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    const root = put_blob(bucket, store, 'teams/data/t/root', 'hello');
    const hosted = put_blob(bucket, store, 'teams/data/t/hosted', 'image');
    const threads = { 'root-1': thread(message(root, { hosted: { h1: { ...hosted } } })) };
    put_shard(bucket, store, shards, shard_with(threads));
    const { service, find_by_snapshot } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 3,
      passed: 3,
      failed_storage_keys: [],
      missing_storage_keys: [],
      interrupted: false,
    });
  });

  it('flags a message blob whose bytes no longer match and keeps checking the rest', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    const tampered = put_blob(bucket, store, 'teams/data/t/a', 'original');
    const intact = put_blob(bucket, store, 'teams/data/t/b', 'intact');
    bucket.set(tampered.storage_key, store.encrypt(Buffer.from('replaced')));
    put_shard(
      bucket,
      store,
      shards,
      shard_with({
        'root-1': thread(message(tampered)),
        'root-2': thread(message(intact)),
      }),
    );
    const { service, find_by_snapshot } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 3,
      passed: 2,
      failed_storage_keys: [tampered.storage_key],
      missing_storage_keys: [],
    });
  });

  it('reports a referenced blob that is absent as missing, not as failed', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    const gone: TeamsStoredBlobRef = {
      storage_key: 'teams/data/t/gone',
      checksum: 'unused',
      size_bytes: 3,
    };
    put_shard(bucket, store, shards, shard_with({ 'root-1': thread(message(gone)) }));
    const { service, find_by_snapshot } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 2,
      passed: 1,
      failed_storage_keys: [],
      missing_storage_keys: ['teams/data/t/gone'],
    });
  });

  it('checks the kept version of a deleted message, so its last live content stays verified', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    const tombstone = put_blob(bucket, store, 'teams/data/t/tombstone', 'gone');
    const kept = put_blob(bucket, store, 'teams/data/t/kept', 'last live');
    bucket.set(kept.storage_key, store.encrypt(Buffer.from('corrupted')));
    const root = message(tombstone, {
      deleted_at: TIMESTAMP,
      kept: { ...kept, hosted: {} },
    });
    put_shard(bucket, store, shards, shard_with({ 'root-1': thread(root) }));
    const { service, find_by_snapshot } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 3,
      failed_storage_keys: [kept.storage_key],
    });
  });

  it('reports a shard that fails to load as failed and does not check its threads', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    bucket.set(SHARD_KEY, store.encrypt(Buffer.from('shard bytes')));
    const { service, find_by_snapshot } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 1,
      passed: 0,
      failed_storage_keys: [SHARD_KEY],
      missing_storage_keys: [],
    });
  });

  it('reports a shard that is absent as missing', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 1,
      passed: 0,
      missing_storage_keys: [SHARD_KEY],
    });
  });

  it('fast mode checks that each blob exists without matching its bytes', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    const tampered = put_blob(bucket, store, 'teams/data/t/a', 'original');
    bucket.set(tampered.storage_key, store.encrypt(Buffer.from('replaced')));
    put_shard(bucket, store, shards, shard_with({ 'root-1': thread(message(tampered)) }));
    const { service, find_by_snapshot, get } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT, { fast: true });

    expect(result).toMatchObject({ total_checked: 2, passed: 2, failed_storage_keys: [] });
    expect(get).not.toHaveBeenCalledWith(tampered.storage_key);
  });

  it('stops before the first shard when interrupted and reports it', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const { service, find_by_snapshot } = setup(store, bucket);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT, {
      should_interrupt: () => true,
    });

    expect(result).toMatchObject({ total_checked: 0, interrupted: true });
  });

  it('raises NotFoundError when the snapshot index does not exist', async () => {
    const store = stub_encrypted_object_store();
    const { service, find_by_snapshot } = setup(store, new Map());
    find_by_snapshot.mockResolvedValue(undefined);

    await expect(service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
