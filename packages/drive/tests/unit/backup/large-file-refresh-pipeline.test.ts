import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import type { DriveDeltaItem } from '@/drive-ports';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import { process_drive_backup_file } from '@/backup/file-processor';
import { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
import { process_large_drive_file, type DriveLargeFileDeps } from '@/backup/large-file-pipeline';
import { DownloadUrlExpiredError } from '@/backup/large-file-url-refresh';
import { build_drive_storage_keys } from '@/shared/storage-keys';

// Issue #718, at the level the OneDrive and SharePoint pipelines both run: the shared large-file
// pipeline and the file processor above it. The chunk source is scripted, so no network is touched.

const KEY = randomBytes(32);
const CHUNKS = 5;
const TOTAL = CHUNKS * CHUNK_SIZE_BYTES;
const PAYLOAD = Buffer.alloc(TOTAL, 9);

type Fetch = DriveLargeFileDeps['fetch_chunks'];

function expired_chunk_error(status = 403): ChunkDownloadError {
  return new ChunkDownloadError(
    `Failed chunk after 1 attempts: HTTP ${status}`,
    new CdnHttpError(`HTTP ${status}`, status),
  );
}

/** Serves each URL until its expiry offset, then refuses it with the CDN's 403. */
function scripted_fetch(expires_at: Record<string, number>): {
  fetch_chunks: Fetch;
  calls: Array<{ url: string; start: number }>;
} {
  const calls: Array<{ url: string; start: number }> = [];
  const fetch_chunks: Fetch = async function* (url, total, _id, _signal, start_offset = 0) {
    calls.push({ url, start: start_offset });
    const expiry = expires_at[url] ?? Number.POSITIVE_INFINITY;
    for (let offset = start_offset; offset < total; offset += CHUNK_SIZE_BYTES) {
      if (offset >= expiry) throw expired_chunk_error();
      yield PAYLOAD.subarray(offset, Math.min(offset + CHUNK_SIZE_BYTES, total));
    }
  };
  return { fetch_chunks, calls };
}

function make_ctx(): { ctx: TenantContext; ops: string[] } {
  const ops: string[] = [];
  const ctx = {
    tenant_id: 'tenant-1',
    storage: {
      begin_multipart_upload: vi.fn(async () => ({
        upload_part: vi.fn(async () => 'etag'),
        complete: vi.fn(async () => {
          ops.push('complete');
        }),
        abort: vi.fn(async () => {
          ops.push('abort');
        }),
      })),
      exists: vi.fn(async () => false),
      copy: vi.fn(async () => {
        ops.push('copy');
      }),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn(async () => 0),
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

function make_deps(fetch_chunks: Fetch): DriveLargeFileDeps {
  return { keys: build_drive_storage_keys('test-drive'), fetch_chunks };
}

function make_item(size_bytes: number): DriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'movie.mp4',
    parent_path: '/Videos',
    size_bytes,
    deleted: false,
    download_url: 'https://cdn.example.invalid/from-delta',
  } as DriveDeltaItem;
}

function make_connector(resolve: () => Promise<string | undefined>): {
  resolve_download_url: ReturnType<typeof vi.fn>;
} {
  return { resolve_download_url: vi.fn(resolve) };
}

describe('process_large_drive_file with URL refresh (issue #718)', () => {
  it('resolves a fresh URL when the download starts, not the one from the listing', async () => {
    const { fetch_chunks, calls } = scripted_fetch({});
    const { ctx } = make_ctx();
    const connector = make_connector(async () => 'https://cdn.example.invalid/fresh');

    const result = await process_large_drive_file(
      make_deps(fetch_chunks),
      connector as never,
      make_item(TOTAL),
      'owner-1',
      ctx,
    );

    expect(result.stored).toBe(true);
    expect(connector.resolve_download_url).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ url: 'https://cdn.example.invalid/fresh', start: 0 }]);
  });

  it('stores the whole file after a URL that expires on its first range', async () => {
    const { fetch_chunks, calls } = scripted_fetch({ stale: 0 });
    const { ctx, ops } = make_ctx();
    const urls = ['stale', 'fresh'];
    const connector = make_connector(async () => urls.shift());

    const result = await process_large_drive_file(
      make_deps(fetch_chunks),
      connector as never,
      make_item(TOTAL),
      'owner-1',
      ctx,
    );

    expect(result.stored).toBe(true);
    expect(ops).toContain('complete');
    expect(calls).toEqual([
      { url: 'stale', start: 0 },
      { url: 'fresh', start: 0 },
    ]);
  });

  it('resumes at the failed range when the URL expires in the middle of the file', async () => {
    const { fetch_chunks, calls } = scripted_fetch({ stale: 3 * CHUNK_SIZE_BYTES });
    const { ctx, ops } = make_ctx();
    const urls = ['stale', 'fresh'];
    const connector = make_connector(async () => urls.shift());

    const result = await process_large_drive_file(
      make_deps(fetch_chunks),
      connector as never,
      make_item(TOTAL),
      'owner-1',
      ctx,
    );

    expect(result.stored).toBe(true);
    expect(ops).toContain('complete');
    expect(calls).toEqual([
      { url: 'stale', start: 0 },
      { url: 'fresh', start: 3 * CHUNK_SIZE_BYTES },
    ]);
  });

  it('propagates a Graph refusal from the re-resolve and uploads nothing', async () => {
    const { fetch_chunks } = scripted_fetch({ stale: 0 });
    const { ctx, ops } = make_ctx();
    const refusal = new DownloadRefusedError('refused', 'notAllowed');
    let first = true;
    const connector = make_connector(async () => {
      if (first) {
        first = false;
        return 'stale';
      }
      throw refusal;
    });

    await expect(
      process_large_drive_file(
        make_deps(fetch_chunks),
        connector as never,
        make_item(TOTAL),
        'owner-1',
        ctx,
      ),
    ).rejects.toBe(refusal);
    expect(ops).not.toContain('complete');
    expect(ops).not.toContain('copy');
  });
});

describe('process_drive_backup_file for a large file (issue #718)', () => {
  const size = LARGE_FILE_THRESHOLD;

  it('hands an expired URL to the caller as DownloadUrlExpiredError instead of skipping it', async () => {
    // Every URL is refused before any byte lands, so no data is read.
    const { fetch_chunks } = scripted_fetch({ u0: 0, u1: 0, u2: 0, u3: 0 });
    const { ctx } = make_ctx();
    const urls = ['u0', 'u1', 'u2', 'u3'];
    const connector = make_connector(async () => urls.shift());

    const error = await process_drive_backup_file(
      make_deps(fetch_chunks),
      connector as never,
      make_item(size),
      'owner-1',
      ctx,
      async () => undefined,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DownloadUrlExpiredError);
  });

  it('still skips a large file for an unrelated transfer failure', async () => {
    const fetch_chunks: Fetch = async function* () {
      yield* [];
      throw new ChunkDownloadError('Failed chunk: HTTP 404', new CdnHttpError('x', 404));
    };
    const { ctx } = make_ctx();
    const connector = make_connector(async () => 'fresh');

    const result = await process_drive_backup_file(
      make_deps(fetch_chunks),
      connector as never,
      make_item(size),
      'owner-1',
      ctx,
      async () => undefined,
    );

    expect(result).toBeUndefined();
    expect(connector.resolve_download_url).toHaveBeenCalledTimes(1);
  });
});
