import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import type { DriveDeltaItem } from '@/drive-ports';
import { create_cdn_chunk_downloader } from '@/backup/cdn-chunk-download';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { DownloadIntegrityError } from '@/backup/download-integrity';
import { process_large_drive_file, type DriveLargeFileDeps } from '@/backup/large-file-pipeline';
import { build_drive_storage_keys } from '@/shared/storage-keys';

// Issue #721: the file was 8 MiB when the delta listing was read and 12 MiB when it was downloaded.
// Each range is still answered with the bytes asked for, so only the Content-Range total shows the
// change. The pipeline must fail the item and must not promote a staged object to its canonical key.

const PLANNED_BYTES = 2 * CHUNK_SIZE_BYTES;
const GROWN_BYTES = 3 * CHUNK_SIZE_BYTES;
const DOWNLOAD_URL = 'https://cdn.example.invalid/grows';

interface RangeInit {
  readonly headers: Record<string, string>;
}

/** A 206 whose body is the requested range and whose Content-Range reports `total`. */
function range_answer(init: RangeInit, total: number): Response {
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers['Range'] ?? '')!;
  const body = Buffer.alloc(Number(end) - Number(start) + 1, 1);
  const copy = new Uint8Array(body);
  return {
    status: 206,
    ok: true,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-range' ? `bytes ${start}-${end}/${total}` : null,
    },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(copy.buffer),
    body: {
      cancel: (): Promise<void> => Promise.resolve(),
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield copy;
      },
    },
  } as unknown as Response;
}

/** A CDN whose file is `total_for(call)` bytes long on each request, counted in arrival order. */
function stub_cdn(total_for: (call: number) => number): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RangeInit) =>
      Promise.resolve(range_answer(init, total_for(call++))),
    ),
  );
}

/** A tenant context whose storage records every write, so a promotion can be seen in `ops`. */
function recording_context(): { ctx: TenantContext; ops: string[] } {
  const ops: string[] = [];
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
  const storage = {
    begin_multipart_upload: vi.fn(async () => handle),
    exists: vi.fn(async () => false),
    put: vi.fn(async () => {
      ops.push('put');
    }),
    copy: vi.fn(async () => {
      ops.push('copy');
    }),
    delete: vi.fn(async () => undefined),
    list_stale: vi.fn(async () => []),
    abort_incomplete_uploads: vi.fn(async () => 0),
  };
  const ctx = {
    tenant_id: 'tenant-1',
    storage,
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
  return { ctx, ops };
}

function large_item(): DriveDeltaItem {
  return {
    item_id: 'item-1',
    file_name: 'grows.bin',
    size_bytes: PLANNED_BYTES,
    download_url: DOWNLOAD_URL,
  } as unknown as DriveDeltaItem;
}

function pipeline_deps(): DriveLargeFileDeps {
  return {
    keys: build_drive_storage_keys('onedrive'),
    fetch_chunks: create_cdn_chunk_downloader('onedrive').fetch_file_chunks,
  };
}

function run_pipeline(ctx: TenantContext): ReturnType<typeof process_large_drive_file> {
  // Large downloads resolve a fresh URL when they start (issue #718), so the stub must return one.
  const connector = { resolve_download_url: vi.fn(async () => DOWNLOAD_URL) };
  return process_large_drive_file(pipeline_deps(), connector, large_item(), 'owner-1', ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('large file pipeline with a file that changes size mid-transfer (issue #721)', () => {
  it('fails a file that grew after its listing and stores nothing at the canonical key', async () => {
    // The first range was cut from the planned size; the second is answered from the grown file.
    stub_cdn((call) => (call === 0 ? PLANNED_BYTES : GROWN_BYTES));
    const { ctx, ops } = recording_context();

    await expect(run_pipeline(ctx)).rejects.toBeInstanceOf(DownloadIntegrityError);
    expect(ops).not.toContain('complete');
    expect(ops).not.toContain('copy');
    expect(ops).not.toContain('put');
    expect(ops).toContain('abort');
  });

  it('stores the file when every range agrees with the planned size', async () => {
    stub_cdn(() => PLANNED_BYTES);
    const { ctx, ops } = recording_context();

    const result = await run_pipeline(ctx);

    expect(result.stored).toBe(true);
    expect(ops).toContain('complete');
    expect(ops).toContain('copy');
  });
});
