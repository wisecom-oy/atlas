import { describe, expect, it } from 'vitest';
import type { TeamsChannelCheckpointHead, TenantContext } from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { S3TeamsChannelCheckpointRepository } from '@/adapters/s3-teams-channel-checkpoint-repository.adapter';
import { teams_checkpoint_head_key } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CHANNEL = 'channel-1';
const SEGMENT = { threads: { 'msg-1': null }, seen: ['msg-1'] };

function head(overrides: Partial<TeamsChannelCheckpointHead> = {}): TeamsChannelCheckpointHead {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: CHANNEL,
    start_link: undefined,
    pending_delta_link: undefined,
    next_page: undefined,
    baseline_shard_key: `teams/shards/${TEAM}/${CHANNEL}/name.json`,
    mode: 'full',
    phase: 'list',
    segments: [],
    failed_roots: {},
    hosted_recheck: {},
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A context over an in-memory bucket of encrypted objects, with delete and prefix listing. */
function make_ctx(store: StubEncryptedObjectStore, bucket: Map<string, Buffer>): TenantContext {
  return {
    storage: {
      exists: async (key: string) => bucket.has(key),
      get: async (key: string) => {
        const body = bucket.get(key);
        if (body === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
        return body;
      },
      put: async (key: string, body: Buffer) => {
        bucket.set(key, body);
      },
      delete: async (key: string) => {
        bucket.delete(key);
      },
      list: async (prefix: string) => [...bucket.keys()].filter((key) => key.startsWith(prefix)),
    },
    encrypt: (plaintext: Buffer) => store.encrypt(plaintext),
    decrypt: (payload: Buffer) => store.decrypt(payload),
  } as unknown as TenantContext;
}

describe('S3TeamsChannelCheckpointRepository', () => {
  it('loads back the head and segment it saved', async () => {
    const store = stub_encrypted_object_store();
    const ctx = make_ctx(store, new Map());
    const repository = new S3TeamsChannelCheckpointRepository();

    await repository.save_segment(ctx, TEAM, CHANNEL, 'seg-abc-0', SEGMENT);
    await repository.save_head(ctx, head({ segments: ['seg-abc-0'] }));

    await expect(repository.load_head(ctx, TEAM, CHANNEL)).resolves.toEqual(
      head({ segments: ['seg-abc-0'] }),
    );
    await expect(repository.load_segment(ctx, TEAM, CHANNEL, 'seg-abc-0')).resolves.toEqual(
      SEGMENT,
    );
  });

  it('returns undefined for a channel with no saved checkpoint', async () => {
    const ctx = make_ctx(stub_encrypted_object_store(), new Map());

    await expect(
      new S3TeamsChannelCheckpointRepository().load_head(ctx, TEAM, CHANNEL),
    ).resolves.toBeUndefined();
  });

  it('raises UnreadableContentError when a head is copied under another channel key', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = make_ctx(store, bucket);
    const repository = new S3TeamsChannelCheckpointRepository();
    await repository.save_head(ctx, head());
    const copied_key = teams_checkpoint_head_key(TEAM, 'channel-2');
    bucket.set(copied_key, bucket.get(teams_checkpoint_head_key(TEAM, CHANNEL)) as Buffer);

    await expect(repository.load_head(ctx, TEAM, 'channel-2')).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });

  it('raises UnreadableContentError when a segment the head names is missing', async () => {
    const ctx = make_ctx(stub_encrypted_object_store(), new Map());
    const repository = new S3TeamsChannelCheckpointRepository();

    await expect(repository.load_segment(ctx, TEAM, CHANNEL, 'seg-gone-0')).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });

  it('deletes only the named channel checkpoint, not one whose ID it prefixes', async () => {
    const ctx = make_ctx(stub_encrypted_object_store(), new Map());
    const repository = new S3TeamsChannelCheckpointRepository();
    await repository.save_segment(ctx, TEAM, CHANNEL, 'seg-abc-0', SEGMENT);
    await repository.save_head(ctx, head({ segments: ['seg-abc-0'] }));
    await repository.save_head(ctx, head({ channel_id: 'channel-10' }));

    await repository.delete_channel(ctx, TEAM, CHANNEL);

    await expect(repository.load_head(ctx, TEAM, CHANNEL)).resolves.toBeUndefined();
    await expect(repository.load_head(ctx, TEAM, 'channel-10')).resolves.toBeDefined();
  });
});
