import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { stream_to_content_addressed_storage } from '@/services/shared/stream-encrypt-upload';

/**
 * Issue #795: the staging object was deleted by key. Every bucket Atlas creates is versioned, so
 * that delete only added a delete marker and the whole object stayed as a noncurrent version until
 * the 30-day lifecycle rule expired it. Each large file was stored twice for a month.
 */

const KEY = randomBytes(32);
const STAGING_KEY = 'onedrive/staging/owner-1/item-1-abc';

interface Bucket {
  /** The version the completed staging upload is given, or none for a bucket without versioning. */
  readonly staged_version_id?: string;
  readonly copy_fails?: boolean;
  readonly version_delete_fails?: boolean;
}

function make_ctx(bucket: Bucket): { ctx: TenantContext; ops: string[] } {
  const ops: string[] = [];
  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      begin_multipart_upload: vi.fn(async () => ({
        upload_part: vi.fn(async (part_number: number) => `etag-${part_number}`),
        complete: vi.fn(async () => {
          ops.push('complete');
          return bucket.staged_version_id ? { version_id: bucket.staged_version_id } : {};
        }),
        abort: vi.fn(async () => {
          ops.push('abort');
        }),
      })),
      exists: vi.fn(async () => false),
      copy: vi.fn(async () => {
        ops.push('copy');
        if (bucket.copy_fails === true) throw new Error('copy refused');
      }),
      delete: vi.fn(async (key: string) => {
        ops.push(`delete:${key}`);
      }),
      delete_version: vi.fn(async (key: string, version_id: string) => {
        ops.push(`delete_version:${key}@${version_id}`);
        if (bucket.version_delete_fails === true) throw new Error('retained by a bucket default');
      }),
    },
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
  return { ctx, ops };
}

async function* one_chunk(): AsyncGenerator<Buffer> {
  yield randomBytes(1024);
}

const TARGET = {
  staging_key: STAGING_KEY,
  data_scope: 'onedrive/data/owner-1/',
  build_data_key: (content_name: string) => `onedrive/data/owner-1/${content_name}`,
};

describe('removing a promoted staging object (issue #795)', () => {
  it('deletes the version the upload created, so a versioned bucket keeps none of its bytes', async () => {
    const { ctx, ops } = make_ctx({ staged_version_id: 'v-staged' });

    const result = await stream_to_content_addressed_storage(ctx, one_chunk(), TARGET);

    expect(result.stored).toBe(true);
    expect(ops).toEqual(['complete', 'copy', `delete_version:${STAGING_KEY}@v-staged`]);
  });

  it('never adds a delete marker on top of the version it removed', async () => {
    const { ctx } = make_ctx({ staged_version_id: 'v-staged' });

    await stream_to_content_addressed_storage(ctx, one_chunk(), TARGET);

    expect(ctx.storage.delete).not.toHaveBeenCalled();
  });

  it('deletes by key, as before, when the bucket reported no version', async () => {
    const { ctx, ops } = make_ctx({});

    await stream_to_content_addressed_storage(ctx, one_chunk(), TARGET);

    expect(ops).toEqual(['complete', 'copy', `delete:${STAGING_KEY}`]);
    expect(ctx.storage.delete_version).not.toHaveBeenCalled();
  });

  it('removes the staged version when promotion fails, and rethrows', async () => {
    const { ctx, ops } = make_ctx({ staged_version_id: 'v-staged', copy_fails: true });

    await expect(stream_to_content_addressed_storage(ctx, one_chunk(), TARGET)).rejects.toThrow(
      'copy refused',
    );
    expect(ops.at(-1)).toBe(`delete_version:${STAGING_KEY}@v-staged`);
  });

  it('hides the key behind a delete marker when the version cannot be removed', async () => {
    // A bucket default retention locks the staging version. The file is already on its canonical
    // key, so the backup must still succeed and the key must still leave the current listing.
    const { ctx, ops } = make_ctx({ staged_version_id: 'v-staged', version_delete_fails: true });

    const result = await stream_to_content_addressed_storage(ctx, one_chunk(), TARGET);

    expect(result.stored).toBe(true);
    expect(ops.slice(-2)).toEqual([
      `delete_version:${STAGING_KEY}@v-staged`,
      `delete:${STAGING_KEY}`,
    ]);
  });
});
