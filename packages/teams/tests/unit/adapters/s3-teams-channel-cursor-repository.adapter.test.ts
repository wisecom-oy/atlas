import { describe, expect, it } from 'vitest';
import type { TeamsChannelCursor, TenantContext } from '@wisecom/atlas-types';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { S3TeamsChannelCursorRepository } from '@/adapters/s3-teams-channel-cursor-repository.adapter';
import { teams_cursor_key } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CHANNEL = 'channel-1';

function cursor(overrides: Partial<TeamsChannelCursor> = {}): TeamsChannelCursor {
  return {
    format_version: 1,
    team_id: TEAM,
    channel_id: CHANNEL,
    baseline_shard_key: `teams/manifests/${TEAM}/channels/${CHANNEL}/name.json`,
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamsChannelCursor;
}

/** A context over an in-memory bucket of encrypted objects. */
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
      list: async (prefix: string) => [...bucket.keys()].filter((key) => key.startsWith(prefix)),
    },
    encrypt: (plaintext: Buffer) => store.encrypt(plaintext),
    decrypt: (payload: Buffer) => store.decrypt(payload),
  } as unknown as TenantContext;
}

describe('S3TeamsChannelCursorRepository', () => {
  it('loads back the cursor it saved', async () => {
    const store = stub_encrypted_object_store();
    const ctx = make_ctx(store, new Map());
    const repository = new S3TeamsChannelCursorRepository();

    await repository.save(ctx, cursor());

    await expect(repository.load(ctx, TEAM, CHANNEL)).resolves.toEqual(cursor());
  });

  it('returns undefined for a channel with no saved cursor', async () => {
    const ctx = make_ctx(stub_encrypted_object_store(), new Map());

    await expect(new S3TeamsChannelCursorRepository().load(ctx, TEAM, CHANNEL)).resolves.toBe(
      undefined,
    );
  });

  it('rejects a cursor copied under another channel key', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = make_ctx(store, bucket);
    await new S3TeamsChannelCursorRepository().save(ctx, cursor());
    const moved = teams_cursor_key(TEAM, 'channel-2');
    bucket.set(moved, bucket.get(teams_cursor_key(TEAM, CHANNEL)) ?? Buffer.alloc(0));

    await expect(new S3TeamsChannelCursorRepository().list(ctx, TEAM)).rejects.toBeInstanceOf(
      UnreadableContentError,
    );
  });

  it('raises UnsupportedFormatVersionError for a newer cursor', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = make_ctx(store, bucket);
    const newer = { ...cursor(), format_version: 2 };
    bucket.set(teams_cursor_key(TEAM, CHANNEL), store.encrypt(Buffer.from(JSON.stringify(newer))));

    await expect(
      new S3TeamsChannelCursorRepository().load(ctx, TEAM, CHANNEL),
    ).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
  });
});
