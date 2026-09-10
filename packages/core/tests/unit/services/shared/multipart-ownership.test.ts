import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stream_to_content_addressed_storage } from '@/services/shared/stream-encrypt-upload';

/**
 * Issue #345: an upload that had started was only aborted when the source failed. A failing
 * `exists()` check or a completion the backend refused returned the handle to nobody, leaving the
 * upload active and its parts billable with no id left to abort it by.
 */

interface Recorded {
  readonly ctx: TenantContext;
  readonly ops: string[];
}

function make_ctx(options: { exists_fails?: boolean; complete_fails?: boolean } = {}): Recorded {
  const ops: string[] = [];
  const ctx = {
    storage: {
      begin_multipart_upload: vi.fn(async (key: string) => {
        ops.push(`begin:${key}`);
        return {
          upload_part: vi.fn(async () => 'etag'),
          complete: vi.fn(async () => {
            ops.push('complete');
            if (options.complete_fails === true) throw new Error('the bucket refused the assembly');
          }),
          abort: vi.fn(async () => {
            ops.push('abort');
          }),
        };
      }),
      exists: vi.fn(async () => {
        ops.push('exists');
        if (options.exists_fails === true) throw new Error('the bucket refused the head request');
        return false;
      }),
      copy: vi.fn(async () => {
        ops.push('copy');
      }),
      delete: vi.fn(async () => {
        ops.push('delete');
      }),
      abort_incomplete_uploads: vi.fn(async () => {
        ops.push('abort_incomplete');
        return 0;
      }),
      list_stale: vi.fn(async () => []),
    },
    create_cipher: stub_tenant_create_cipher,
  } as unknown as TenantContext;
  return { ctx, ops };
}

async function* one_chunk(): AsyncGenerator<Buffer> {
  yield randomBytes(1024);
}

const TARGET = {
  staging_key: 'onedrive/staging/owner-1/item-1',
  build_data_key: (checksum: string) => `onedrive/data/owner-1/${checksum}`,
  data_scope: 'onedrive/data/owner-1/',
};

describe('multipart upload ownership (issue #345)', () => {
  it('aborts its own upload when the existence check fails', async () => {
    const recorded = make_ctx({ exists_fails: true });

    await expect(
      stream_to_content_addressed_storage(recorded.ctx, one_chunk(), TARGET),
    ).rejects.toThrow(/head request/);

    expect(recorded.ops).toEqual(['begin:onedrive/staging/owner-1/item-1', 'exists', 'abort']);
  });

  it('aborts its own upload when the completion is refused', async () => {
    const recorded = make_ctx({ complete_fails: true });

    await expect(
      stream_to_content_addressed_storage(recorded.ctx, one_chunk(), TARGET),
    ).rejects.toThrow(/refused the assembly/);

    expect(recorded.ops).toContain('abort');
    // Never the prefix sweep: it would take a concurrent run's upload with it.
    expect(recorded.ops).not.toContain('abort_incomplete');
    expect(recorded.ops).not.toContain('copy');
  });

  it('does not abort anything on the path that succeeds', async () => {
    const recorded = make_ctx();

    const result = await stream_to_content_addressed_storage(recorded.ctx, one_chunk(), TARGET);

    expect(result.stored).toBe(true);
    expect(recorded.ops).not.toContain('abort');
    expect(recorded.ops).toContain('copy');
  });
});
