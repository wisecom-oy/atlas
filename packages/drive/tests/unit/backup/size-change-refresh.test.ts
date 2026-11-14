import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';
import { CHUNK_DOWNLOAD_THRESHOLD, create_cdn_chunk_downloader } from '@/backup/cdn-chunk-download';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { download_from_url } from '@/backup/cdn-url-download';
import { assert_range_chunk } from '@/backup/download-integrity';
import { process_drive_backup_file } from '@/backup/file-processor';
import { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
import type { DriveItemRefetch } from '@/backup/download-size-refresh';
import { build_drive_storage_keys } from '@/shared/storage-keys';

// Issue #759: SharePoint rewrote a file on its first download, so the bytes served were larger than
// the size the listing reported. The file must be stored with the size it now has, on each of the
// paths a download can take. `fetch` is the only thing stubbed; the transfer and integrity code is
// the real code.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const SMALL_PLANNED = 1024 * 1024;
const SMALL_GROWN = SMALL_PLANNED + 512 * 1024;
const CHUNKED_PLANNED = 2 * CHUNK_SIZE_BYTES;
const CHUNKED_GROWN = CHUNKED_PLANNED + CHUNK_SIZE_BYTES;
const LARGE_PLANNED = LARGE_FILE_THRESHOLD;
const LARGE_GROWN = LARGE_PLANNED + CHUNK_SIZE_BYTES;
const URL_FROM_LISTING = 'https://cdn.example.invalid/listing';
const URL_FRESH = 'https://cdn.example.invalid/fresh';

/**
 * Serves the file as it is on each request. `size_for(call)` is the file's length on the nth
 * request, so a file that grows once and then holds still is `() => grown` after the first call.
 */
function serve_file(size_for: (call: number) => number): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      const total = size_for(call++);
      const range = init?.headers?.Range;
      if (!range) return new Response(Buffer.alloc(total, 7), { status: 200 });
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range)!;
      const body = Buffer.alloc(Number(end) - Number(start) + 1, 7);
      return new Response(body, {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
      });
    }),
  );
}

interface StorageRecord {
  readonly ops: string[];
  readonly put: ReturnType<typeof vi.fn>;
}

/** A tenant context whose storage records every write, so the stored length can be checked. */
function make_ctx(): { ctx: TenantContext; record: StorageRecord } {
  const ops: string[] = [];
  const put = vi.fn(async () => {
    ops.push('put');
  });
  const handle = {
    upload_part: vi.fn(async (part_number: number) => {
      ops.push(`part:${part_number}`);
      return `etag-${part_number}`;
    }),
    complete: vi.fn(async () => {
      ops.push('complete');
    }),
    abort: vi.fn(async () => {
      ops.push('abort');
    }),
  };
  const ctx = {
    tenant_id: 'tenant-1',
    encrypt: (body: Buffer) => body,
    storage: {
      exists: vi.fn(async () => false),
      put,
      copy: vi.fn(async () => {
        ops.push('copy');
      }),
      delete: vi.fn(async () => undefined),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn(async () => 0),
      begin_multipart_upload: vi.fn(async () => handle),
    },
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
  return { ctx, record: { ops, put } };
}

function make_item(size_bytes: number): DriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    kind: 'file',
    file_name: 'Message.msg',
    parent_path: '/Documents',
    size_bytes,
    deleted: false,
    download_url: URL_FROM_LISTING,
  } as DriveDeltaItem;
}

/**
 * A connector that routes like the shared executor: a range download above the chunk threshold and
 * a single request below it, both through the real transfer code.
 */
function make_connector(): DriveContentConnector & { resolve_download_url: () => Promise<string> } {
  const chunker = create_cdn_chunk_downloader('onedrive');
  return {
    download_file_content: vi.fn((item: DriveDeltaItem, signal?: AbortSignal) =>
      item.size_bytes > CHUNK_DOWNLOAD_THRESHOLD
        ? chunker.download_file_chunked(
            item.download_url ?? URL_FRESH,
            item.size_bytes,
            item.item_id,
            signal,
          )
        : download_from_url(
            'OneDrive',
            item.download_url ?? URL_FRESH,
            item.size_bytes,
            item.item_id,
            signal,
          ),
    ),
    resolve_download_url: vi.fn(async () => URL_FRESH),
  } as unknown as DriveContentConnector & { resolve_download_url: () => Promise<string> };
}

/** The item as Graph reports it once the file has settled at `size_bytes`. */
function refetch_reporting(size_bytes: number): DriveItemRefetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (item: DriveDeltaItem) => ({
    ...item,
    size_bytes,
    download_url: URL_FRESH,
  })) as unknown as DriveItemRefetch & ReturnType<typeof vi.fn>;
}

const deps = {
  keys: build_drive_storage_keys('onedrive'),
  fetch_chunks: create_cdn_chunk_downloader('onedrive').fetch_file_chunks,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a file that grows on its first download and is then stable (issue #759)', () => {
  it('is stored with the new size on the whole-file path', async () => {
    serve_file(() => SMALL_GROWN);
    const { ctx, record } = make_ctx();
    const refetch = refetch_reporting(SMALL_GROWN);

    const result = await process_drive_backup_file(
      deps,
      make_connector(),
      make_item(SMALL_PLANNED),
      'owner-1',
      ctx,
      refetch,
    );

    expect(result?.stored).toBe(true);
    expect(result?.size_bytes).toBe(SMALL_GROWN);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(record.put).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('item-1'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is stored with the new size on the chunked path, where the Content-Range total shows the change', async () => {
    serve_file(() => CHUNKED_GROWN);
    const { ctx } = make_ctx();
    const refetch = refetch_reporting(CHUNKED_GROWN);

    const result = await process_drive_backup_file(
      deps,
      make_connector(),
      make_item(CHUNKED_PLANNED),
      'owner-1',
      ctx,
      refetch,
    );

    expect(result?.stored).toBe(true);
    expect(result?.size_bytes).toBe(CHUNKED_GROWN);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('is stored with the new size on the large-file path, with the staged upload aborted first', async () => {
    serve_file(() => LARGE_GROWN);
    const { ctx, record } = make_ctx();
    const refetch = refetch_reporting(LARGE_GROWN);

    const result = await process_drive_backup_file(
      deps,
      make_connector(),
      make_item(LARGE_PLANNED),
      'owner-1',
      ctx,
      refetch,
    );

    expect(result?.stored).toBe(true);
    expect(result?.size_bytes).toBe(LARGE_GROWN);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(record.ops.indexOf('abort')).toBeGreaterThanOrEqual(0);
    expect(record.ops.indexOf('abort')).toBeLessThan(record.ops.indexOf('complete'));
    expect(record.ops).toContain('copy');
  });
});

describe('a file whose size keeps changing (issue #759)', () => {
  it('fails after exactly one refresh and is skipped as before, not retried in a loop', async () => {
    // Each download finds the file a little larger than the last one, so no refresh ever settles.
    serve_file((call) => (call === 0 ? SMALL_GROWN : SMALL_GROWN + 4096 * call));
    const { ctx, record } = make_ctx();
    const refetch = refetch_reporting(SMALL_GROWN);

    const result = await process_drive_backup_file(
      deps,
      make_connector(),
      make_item(SMALL_PLANNED),
      'owner-1',
      ctx,
      refetch,
    );

    expect(result).toBeUndefined();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(record.put).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('item-1'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('produced'));
  });

  it('does not refresh when the item still lists the planned size, since the metadata did not move', async () => {
    serve_file(() => SMALL_GROWN);
    const { ctx } = make_ctx();
    const refetch = refetch_reporting(SMALL_PLANNED);

    const result = await process_drive_backup_file(
      deps,
      make_connector(),
      make_item(SMALL_PLANNED),
      'owner-1',
      ctx,
      refetch,
    );

    expect(result).toBeUndefined();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('a truncation or wrong-body failure (issues #338, #368, #721)', () => {
  it('does not refresh the item when a range starts or ends at the wrong byte', async () => {
    const connector = {
      download_file_content: vi.fn(async (item: DriveDeltaItem) => {
        // The 206 answers the range asked for with the wrong bytes: not a size change.
        assert_range_chunk(item.item_id, 0, 3, 'bytes 4-7/8', 4, 8);
        return Buffer.alloc(0);
      }),
      resolve_download_url: vi.fn(async () => URL_FRESH),
    } as unknown as DriveContentConnector & { resolve_download_url: () => Promise<string> };
    const { ctx } = make_ctx();
    const refetch = refetch_reporting(SMALL_PLANNED);

    const result = await process_drive_backup_file(
      deps,
      connector,
      make_item(SMALL_PLANNED),
      'owner-1',
      ctx,
      refetch,
    );

    expect(result).toBeUndefined();
    expect(refetch).not.toHaveBeenCalled();
  });
});
