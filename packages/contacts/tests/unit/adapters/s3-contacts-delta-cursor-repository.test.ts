import { describe, expect, it, vi } from 'vitest';
import { StorageError, UnreadableContentError } from '@wisecom/atlas-types';
import type { ContactsDeltaCursor } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3ContactsDeltaCursorRepository } from '@/adapters/s3-contacts-delta-cursor-repository.adapter';
import { contacts_delta_cursor_key } from '@/services/shared/storage-keys';

const MAILBOX = 'user-b@example.com';

function make_cursor(mailbox_id: string): ContactsDeltaCursor {
  return {
    mailbox_id,
    delta_link_by_folder: { 'folder-1': 'https://graph.microsoft.com/v1.0/delta?token=abc' },
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('S3ContactsDeltaCursorRepository', () => {
  const repo = new S3ContactsDeltaCursorRepository();

  it('round-trips the cursor it saved', async () => {
    const { ctx } = in_memory_tenant_context();

    await repo.save(ctx, make_cursor(MAILBOX));

    await expect(repo.load(ctx, MAILBOX)).resolves.toEqual(make_cursor(MAILBOX));
  });

  it('reports no cursor for a mailbox that has never been backed up', async () => {
    const { ctx } = in_memory_tenant_context();

    await expect(repo.load(ctx, MAILBOX)).resolves.toBeUndefined();
  });

  it('rejects another mailbox cursor stored under this mailbox key', async () => {
    const harness = in_memory_tenant_context();
    const key = contacts_delta_cursor_key(MAILBOX);
    const foreign = Buffer.from(JSON.stringify(make_cursor('user-a@example.com')));
    harness.set_raw(key, harness.ctx.encrypt(foreign, key));

    await expect(repo.load(harness.ctx, MAILBOX)).rejects.toBeInstanceOf(UnreadableContentError);
  });

  it('raises StorageError when the cursor cannot be fetched', async () => {
    const harness = in_memory_tenant_context();
    await repo.save(harness.ctx, make_cursor(MAILBOX));
    vi.spyOn(harness.ctx.storage, 'get').mockRejectedValueOnce(new Error('Service Unavailable'));

    await expect(repo.load(harness.ctx, MAILBOX)).rejects.toBeInstanceOf(StorageError);
  });
});
