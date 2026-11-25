import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  StorageError,
  StorageUnavailableError,
  type TenantContext,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import type { DriveContentConnector, DriveDeltaItem } from '@/drive-ports';
import { process_drive_backup_file } from '@/backup/file-processor';
import { LARGE_FILE_THRESHOLD } from '@/backup/large-file-threshold';
import type { DriveDownloadUrlResolver, DriveLargeFileDeps } from '@/backup/large-file-pipeline';
import { TransientDownloadError } from '@/backup/transient-download-failure';
import { build_drive_storage_keys } from '@/shared/storage-keys';

// Issue #917: a storage failure on a file of 64 MiB or more was logged as `Skipping large file`
// and recorded against the file, so five runs against full or broken storage skipped it for good.
// It now leaves `process_large_or_skip` unchanged, as a small file's failed put does.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  file_name: 'Archive.bin',
  parent_path: '/Documents',
  size_bytes: LARGE_FILE_THRESHOLD,
  kind: 'file',
} as DriveDeltaItem;

const SLICE = Buffer.alloc(8 * 1024 * 1024, 1);

/** The whole planned file in 8 MiB slices, so the stream reaches completion and the copy. */
async function* whole_file(): AsyncGenerator<Buffer> {
  for (let sent = 0; sent < LARGE_FILE_THRESHOLD; sent += SLICE.length) yield SLICE;
}

/** An answer from the S3 endpoint, shaped as the AWS SDK raises it. */
function s3_answer(name: string, status: number): Error {
  return Object.assign(new Error(`${name} from the storage endpoint`), {
    name,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status, attempts: 3 },
  });
}

type StorageStep = 'begin' | 'part' | 'exists' | 'complete' | 'copy';

/** A tenant context whose storage rejects with `err` at `step` and succeeds everywhere else. */
function storage_failing_at(step: StorageStep | 'nowhere', err?: unknown): TenantContext {
  const at = <T>(name: StorageStep, value: T) =>
    vi.fn(async () => {
      if (name === step) throw err;
      return value;
    });
  const handle = {
    upload_part: at('part', 'etag'),
    complete: at('complete', { version_id: 'v1' }),
    abort: vi.fn(async () => undefined),
  };
  return {
    storage: {
      begin_multipart_upload: vi.fn(async () => {
        if (step === 'begin') throw err;
        return handle;
      }),
      exists: at('exists', false),
      copy: at('copy', undefined),
      delete: vi.fn(async () => undefined),
      delete_version: vi.fn(async () => undefined),
    },
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

const CONNECTOR = {
  resolve_download_url: vi.fn(async () => 'https://cdn.example.invalid/item-1'),
} as unknown as DriveContentConnector & DriveDownloadUrlResolver;

function deps_streaming(chunks: () => AsyncIterable<Buffer>): DriveLargeFileDeps {
  return { keys: build_drive_storage_keys('onedrive'), fetch_chunks: chunks };
}

/** Runs the shared file processor for the large item, settling to its value or its error. */
function process_large(deps: DriveLargeFileDeps, ctx: TenantContext): Promise<unknown> {
  return process_drive_backup_file(deps, CONNECTOR, ITEM, 'owner-1', ctx, vi.fn()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe('process_large_or_skip on a storage failure (issue #917)', () => {
  it.each<[string, StorageStep, Error]>([
    ['an S3 InternalError on a part upload', 'part', s3_answer('InternalError', 500)],
    ['a 507 on the multipart completion', 'complete', s3_answer('XMinioStorageFull', 507)],
    ['a QuotaExceeded on the copy to the canonical key', 'copy', s3_answer('QuotaExceeded', 403)],
    ['a 503 on the dedup check', 'exists', s3_answer('ServiceUnavailable', 503)],
    [
      'an endpoint that never answered',
      'begin',
      new StorageUnavailableError('S3 CreateMultipartUpload got no answer', 3, {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      }),
    ],
    ['a malformed multipart answer', 'part', new StorageError('Missing ETag for part 2')],
  ])('rethrows %s unchanged', async (_label, step, err) => {
    const outcome = await process_large(deps_streaming(whole_file), storage_failing_at(step, err));

    expect(outcome).toEqual({ error: err });
    expect((outcome as { error: unknown }).error).toBe(err);
  });

  it('rethrows a config error that wraps the S3 answer, as a refused lock mode does', async () => {
    const refused = new ConfigError('Backend rejected Object Lock mode', {
      cause: s3_answer('InvalidRequest', 400),
    });

    const outcome = await process_large(
      deps_streaming(whole_file),
      storage_failing_at('copy', refused),
    );

    expect(outcome).toEqual({ error: refused });
  });

  it('stores the file when storage answers every step', async () => {
    const outcome = await process_large(deps_streaming(whole_file), storage_failing_at('nowhere'));

    expect(outcome).toMatchObject({ value: { stored: true, size_bytes: LARGE_FILE_THRESHOLD } });
  });
});

describe('process_large_or_skip on a download failure, unchanged by #917', () => {
  async function* reset_mid_file(): AsyncGenerator<Buffer> {
    yield SLICE;
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  }

  async function* refused_mid_file(): AsyncGenerator<Buffer> {
    yield SLICE;
    throw Object.assign(new Error('Bad Request'), { statusCode: 400 });
  }

  it('turns a connection reset into TransientDownloadError', async () => {
    const outcome = await process_large(
      deps_streaming(reset_mid_file),
      storage_failing_at('nowhere'),
    );

    expect(outcome).toEqual({ error: expect.any(TransientDownloadError) });
  });

  it('returns undefined for a CDN 400, which belongs to the file', async () => {
    const outcome = await process_large(
      deps_streaming(refused_mid_file),
      storage_failing_at('nowhere'),
    );

    expect(outcome).toEqual({ value: undefined });
  });
});
