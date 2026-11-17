import { describe, expect, it, vi } from 'vitest';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import type { MailboxDeltaCursor } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3MailboxDeltaCursorRepository } from '@/adapters/s3-mailbox-delta-cursor-repository.adapter';

const OWNER_A = 'owner-a@example.com';
const OWNER_B = 'owner-b@example.com';
const KEY_B = `_meta/outlook-cursors/${OWNER_B}.json`;

function make_cursor(owner_id: string): MailboxDeltaCursor {
  return {
    owner_id,
    delta_links: { 'folder-1': `https://graph.microsoft.com/v1.0/delta?token=${owner_id}` },
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** Stores `body` at `key` encrypted for that key, the way a body copied within one directory decrypts. */
function plant(harness: ReturnType<typeof in_memory_tenant_context>, key: string, body: string) {
  harness.set_raw(key, harness.ctx.encrypt(Buffer.from(body, 'utf-8'), key));
}

describe('S3MailboxDeltaCursorRepository', () => {
  const repo = new S3MailboxDeltaCursorRepository();

  it('round-trips the cursor it saved', async () => {
    const { ctx } = in_memory_tenant_context();

    await repo.save(ctx, make_cursor(OWNER_B));

    await expect(repo.load(ctx, OWNER_B)).resolves.toEqual(make_cursor(OWNER_B));
  });

  it('reports no cursor for a mailbox that has never been backed up', async () => {
    const { ctx } = in_memory_tenant_context();

    await expect(repo.load(ctx, OWNER_B)).resolves.toBeUndefined();
  });

  it('reports a cursor deleted between exists and get as absent', async () => {
    const harness = in_memory_tenant_context();
    await repo.save(harness.ctx, make_cursor(OWNER_B));
    vi.spyOn(harness.ctx.storage, 'get').mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'NoSuchKey' }),
    );

    await expect(repo.load(harness.ctx, OWNER_B)).resolves.toBeUndefined();
  });

  it('rejects another mailbox cursor stored under this mailbox key', async () => {
    const harness = in_memory_tenant_context();
    plant(harness, KEY_B, JSON.stringify(make_cursor(OWNER_A)));

    // Resuming B from A's delta links would skip B's changes and record A's items as B's (#622).
    await expect(repo.load(harness.ctx, OWNER_B)).rejects.toBeInstanceOf(UnreadableContentError);
  });

  it('rejects a cursor body that names no owner', async () => {
    const harness = in_memory_tenant_context();
    plant(harness, KEY_B, 'null');

    await expect(repo.load(harness.ctx, OWNER_B)).rejects.toBeInstanceOf(UnreadableContentError);
  });

  it('raises UnreadableContentError for a cursor that fails to decrypt', async () => {
    const harness = in_memory_tenant_context();
    harness.set_raw(KEY_B, Buffer.from('not ciphertext at all, just bytes'));

    // Reading it as absent would fall back to the manifest links and hide withheld folders.
    await expect(repo.load(harness.ctx, OWNER_B)).rejects.toBeInstanceOf(UnreadableContentError);
  });

  it('raises UnreadableContentError for a cursor that decrypts to invalid JSON', async () => {
    const harness = in_memory_tenant_context();
    plant(harness, KEY_B, '{"owner_id":');

    await expect(repo.load(harness.ctx, OWNER_B)).rejects.toBeInstanceOf(UnreadableContentError);
  });

  it('raises StorageError with the cause when the cursor cannot be fetched', async () => {
    const harness = in_memory_tenant_context();
    await repo.save(harness.ctx, make_cursor(OWNER_B));
    const unavailable = Object.assign(new Error('Service Unavailable'), {
      name: 'ServiceUnavailable',
      $metadata: { httpStatusCode: 503 },
    });
    vi.spyOn(harness.ctx.storage, 'get').mockRejectedValueOnce(unavailable);

    const err = await repo.load(harness.ctx, OWNER_B).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StorageError);
    expect(err instanceof StorageError && err.cause).toBe(unavailable);
  });

  it('raises StorageError when the existence check itself fails', async () => {
    const harness = in_memory_tenant_context();
    vi.spyOn(harness.ctx.storage, 'exists').mockRejectedValueOnce(new Error('Access Denied'));

    await expect(repo.load(harness.ctx, OWNER_B)).rejects.toBeInstanceOf(StorageError);
  });

  it('encrypts the cursor before it is stored', async () => {
    const harness = in_memory_tenant_context();

    await repo.save(harness.ctx, make_cursor(OWNER_B));

    // The cursor carries Graph delta tokens, which are bearer-equivalent.
    expect(harness.raw(KEY_B)?.toString('utf-8')).not.toContain('delta?token=');
  });
});
