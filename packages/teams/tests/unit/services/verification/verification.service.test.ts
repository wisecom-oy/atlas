import { describe, expect, it } from 'vitest';
import type { TeamsChannelShard, TeamsStoredBlobRef } from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import {
  index_listing,
  put_blob,
  put_shard,
  message,
  setup,
  SHARD_KEY,
  shard_with,
  SNAPSHOT,
  TEAM,
  thread,
  TIMESTAMP,
} from './verification-harness';

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

  it('reports a shard written in a newer format as unsupported, not failed or a mismatch', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    bucket.set(SHARD_KEY, store.encrypt(Buffer.from('newer shard')));
    const { service, find_by_snapshot } = setup(store, bucket, new Map(), [SHARD_KEY]);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({
      total_checked: 1,
      passed: 0,
      failed_storage_keys: [],
      missing_storage_keys: [],
      unsupported_storage_keys: [SHARD_KEY],
    });
  });

  it('checks a blob once when a kept version shares it with a live version (P12)', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const shards = new Map<string, TeamsChannelShard>();
    const live = put_blob(bucket, store, 'teams/data/t/live', 'live');
    const tombstone = put_blob(bucket, store, 'teams/data/t/tombstone', 'gone');
    put_shard(
      bucket,
      store,
      shards,
      shard_with({
        'root-1': thread(message(live)),
        'root-2': thread(
          message(tombstone, { deleted_at: TIMESTAMP, kept: { ...live, hosted: {} } }),
        ),
      }),
    );
    const { service, find_by_snapshot } = setup(store, bucket, shards);
    find_by_snapshot.mockResolvedValue(index_listing(SHARD_KEY));

    const result = await service.verify_teams_snapshot('tenant', TEAM, SNAPSHOT);

    expect(result).toMatchObject({ total_checked: 3, passed: 3, failed_storage_keys: [] });
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
