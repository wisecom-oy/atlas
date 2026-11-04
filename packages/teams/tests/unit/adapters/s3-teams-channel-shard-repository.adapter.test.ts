import { describe, expect, it, vi } from 'vitest';
import type { TeamsChannelShard, TenantContext } from '@wisecom/atlas-types';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { S3TeamsChannelShardRepository } from '@/adapters/s3-teams-channel-shard-repository.adapter';
import { teams_channel_shard_key } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CHANNEL = 'channel-1';

function shard(overrides: Partial<TeamsChannelShard> = {}): TeamsChannelShard {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: CHANNEL,
    channel: { id: CHANNEL, displayName: 'General' },
    members: [],
    tabs: [],
    read_mode: 'full',
    threads: {},
    ...overrides,
  };
}

/** A context over an in-memory bucket. Keys are bound on encrypt and decrypt like the real adapter. */
function make_ctx(store: StubEncryptedObjectStore, bucket: Map<string, Buffer>) {
  const put = vi.fn(async (key: string, body: Buffer) => {
    bucket.set(key, body);
  });
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => {
        const body = bucket.get(key);
        if (body === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
        return body;
      }),
      put,
      exists: vi.fn(async (key: string) => bucket.has(key)),
    },
    encrypt: (plaintext: Buffer) => store.encrypt(plaintext),
    decrypt: (payload: Buffer) => store.decrypt(payload),
    create_content_hmac: () => stub_tenant_create_content_hmac(),
  } as unknown as TenantContext;
  return { ctx, put };
}

describe('S3TeamsChannelShardRepository', () => {
  it('loads back the shard it saved, under the key the save returned', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const { ctx } = make_ctx(store, bucket);
    const repository = new S3TeamsChannelShardRepository();

    const ref = await repository.save(ctx, shard());

    expect(ref.storage_key.startsWith(`teams/manifests/${TEAM}/channels/${CHANNEL}/`)).toBe(true);
    await expect(repository.load(ctx, ref.storage_key)).resolves.toEqual(shard());
  });

  it('writes identical content once, so an unchanged channel adds no object', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const { ctx, put } = make_ctx(store, bucket);
    const repository = new S3TeamsChannelShardRepository();

    const first = await repository.save(ctx, shard());
    const second = await repository.save(ctx, shard());

    expect(second.storage_key).toBe(first.storage_key);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('raises UnreadableContentError for a shard copied under another channel key', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const { ctx } = make_ctx(store, bucket);
    const repository = new S3TeamsChannelShardRepository();
    const ref = await repository.save(ctx, shard());
    const content_name = ref.storage_key.split('/').at(-1) ?? '';
    const moved = teams_channel_shard_key(TEAM, 'channel-2', content_name);
    bucket.set(moved, bucket.get(ref.storage_key) ?? Buffer.alloc(0));

    await expect(repository.load(ctx, moved)).rejects.toBeInstanceOf(UnreadableContentError);
  });

  it('raises UnsupportedFormatVersionError for a newer shard, not UnreadableContentError', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const { ctx } = make_ctx(store, bucket);
    const repository = new S3TeamsChannelShardRepository();
    const newer_body = { ...shard(), format_version: 2 } as unknown as TeamsChannelShard;
    const newer = await repository.save(ctx, newer_body);

    const load = repository.load(ctx, newer.storage_key);

    await expect(load).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
    await expect(load).rejects.not.toBeInstanceOf(UnreadableContentError);
  });

  it('raises UnreadableContentError for a shard that is absent', async () => {
    const store = stub_encrypted_object_store();
    const { ctx } = make_ctx(store, new Map());
    const key = teams_channel_shard_key(TEAM, CHANNEL, 'absent');

    await expect(new S3TeamsChannelShardRepository().load(ctx, key)).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });
});
