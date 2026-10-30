import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { lock_run_writes } from '@/services/shared/run-object-lock';
import { stream_to_content_addressed_storage } from '@/services/shared/stream-encrypt-upload';

const KEY = randomBytes(32);

function make_inner_storage(): ObjectStorage {
  return {
    begin_multipart_upload: vi.fn(async () => ({
      upload_part: vi.fn(async (part_number: number) => `etag-${part_number}`),
      complete: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    })),
    exists: vi.fn(async () => false),
    copy: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    validate_object_lock_policy: vi.fn(async () => {}),
  } as unknown as ObjectStorage;
}

function make_ctx(storage: ObjectStorage): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage,
    create_cipher: () => {
      const iv = randomBytes(12);
      return {
        cipher: createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 }),
        iv,
        header: Buffer.alloc(0),
      };
    },
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

async function* one_chunk(): AsyncGenerator<Buffer> {
  yield randomBytes(1024);
}

const TARGET = {
  staging_key: 'drive/owner/_staging/upload-1',
  build_data_key: (content_name: string) => `drive/owner/data/${content_name}`,
  data_scope: 'drive/owner/data',
};

describe('staging upload on a locked run (#556)', () => {
  it('leaves the staging upload unlocked and locks the canonical copy', async () => {
    const inner = make_inner_storage();
    const ctx = await lock_run_writes(make_ctx(inner), {
      retention_days: 30,
      mode: 'COMPLIANCE',
    });

    const result = await stream_to_content_addressed_storage(ctx, one_chunk(), TARGET);

    expect(inner.begin_multipart_upload).toHaveBeenCalledWith(TARGET.staging_key, undefined);
    expect(inner.copy).toHaveBeenCalledWith(
      TARGET.staging_key,
      result.storage_key,
      undefined,
      expect.objectContaining({ mode: 'COMPLIANCE', retain_until: expect.any(String) }),
    );
    expect(inner.delete).toHaveBeenCalledWith(TARGET.staging_key);
  });

  it('keeps a lock the caller asked for on the canonical copy', async () => {
    const inner = make_inner_storage();
    const own = { mode: 'GOVERNANCE' as const, retain_until: '2030-01-01T00:00:00.000Z' };

    await stream_to_content_addressed_storage(make_ctx(inner), one_chunk(), {
      ...TARGET,
      object_lock_policy: own,
    });

    expect(vi.mocked(inner.copy).mock.calls[0]?.[3]).toBe(own);
    expect(vi.mocked(inner.begin_multipart_upload).mock.calls[0]?.[2]).not.toHaveProperty(
      'retain_until',
    );
  });
});
