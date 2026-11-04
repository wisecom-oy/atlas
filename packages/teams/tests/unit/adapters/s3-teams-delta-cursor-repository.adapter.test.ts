import { describe, expect, it, vi } from 'vitest';
import type { TeamsDeltaCursor, TenantContext } from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import {
  stub_encrypted_object_store,
  type StubEncryptedObjectStore,
} from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { S3TeamsDeltaCursorRepository } from '@/adapters/s3-teams-delta-cursor-repository.adapter';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const CURSOR_KEY = TEAMS_KEYS.delta_cursor_key(TEAM);

const CURSOR: TeamsDeltaCursor = {
  team_id: TEAM,
  snapshot_id: 'teams-snap-2000-bbbbbb',
  delta_link_by_channel: { 'channel-1': 'https://graph.example/delta?token=t1' },
  updated_at: '2025-01-01T00:00:00.000Z',
};

/** Decrypts a sealed payload with `store`'s key. GCM authentication fails under any other key. */
function open_with(store: StubEncryptedObjectStore, payload: Buffer): Buffer {
  const decipher = store.create_decipher(payload.subarray(0, 12), payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

/** A context over an in-memory bucket, encrypting and decrypting with `store`'s key. */
function make_ctx(store: StubEncryptedObjectStore, bucket: Map<string, Buffer>): TenantContext {
  return {
    storage: {
      exists: vi.fn(async (key: string) => bucket.has(key)),
      get: vi.fn(async (key: string) => bucket.get(key)),
      put: vi.fn(async (key: string, body: Buffer) => {
        bucket.set(key, body);
      }),
    },
    encrypt: (plaintext: Buffer) => store.encrypt(plaintext),
    decrypt: (payload: Buffer) => open_with(store, payload),
  } as unknown as TenantContext;
}

describe('S3TeamsDeltaCursorRepository.load', () => {
  it('returns undefined when no cursor was saved for the team', async () => {
    const store = stub_encrypted_object_store();
    const ctx = make_ctx(store, new Map());

    expect(await new S3TeamsDeltaCursorRepository().load(ctx, TEAM)).toBeUndefined();
  });

  it('round-trips a saved cursor through the encrypted object', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = make_ctx(store, bucket);
    const repository = new S3TeamsDeltaCursorRepository();

    await repository.save(ctx, CURSOR);

    expect(bucket.has(CURSOR_KEY)).toBe(true);
    expect(await repository.load(ctx, TEAM)).toEqual(CURSOR);
  });

  it('throws UnreadableContentError naming the key when the cursor cannot be decrypted', async () => {
    const store = stub_encrypted_object_store();
    const other_store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>([
      [CURSOR_KEY, other_store.encrypt(Buffer.from(JSON.stringify(CURSOR)))],
    ]);
    const ctx = make_ctx(store, bucket);

    const load = new S3TeamsDeltaCursorRepository().load(ctx, TEAM);

    await expect(load).rejects.toBeInstanceOf(UnreadableContentError);
    await expect(load).rejects.toThrow(CURSOR_KEY);
  });
});
