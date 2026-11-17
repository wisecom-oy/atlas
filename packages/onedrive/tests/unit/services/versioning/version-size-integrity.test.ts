import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { DownloadIntegrityError } from '@wisecom/atlas-drive/backup/download-integrity';
import { LARGE_FILE_THRESHOLD } from '@wisecom/atlas-drive/backup/large-file-threshold';
import {
  store_version_content,
  VersionDownloadError,
} from '@wisecom/atlas-drive/versioning/version-content-store';
import type {
  DriveContentConnector,
  DriveDeltaItem,
  DriveFileVersion,
} from '@wisecom/atlas-drive/drive-ports';
import type { DriveStorageKeys } from '@wisecom/atlas-drive/shared/storage-keys';

/**
 * Issue #616: a version download was stored with a checksum of whatever arrived, so a truncated
 * body became a valid-looking version that verify later accepted. Both store paths now hold the
 * transferred length to the size Graph listed, and report a short read as a typed integrity error
 * wrapped in `VersionDownloadError`, which the sync classifies as a failed (retryable) version.
 *
 * It lives in the OneDrive package because the drive package's test aliases cannot resolve core
 * source imported through the module under test.
 */

const KEYS: DriveStorageKeys = {
  data_key: (owner_id: string, name: string) => `onedrive/data/${owner_id}/${name}`,
  data_prefix_for: (owner_id: string) => `onedrive/data/${owner_id}/`,
  staging_key: (owner_id: string, item_id: string) => `onedrive/staging/${owner_id}/${item_id}`,
  staging_prefix_for: (owner_id: string) => `onedrive/staging/${owner_id}/`,
} as unknown as DriveStorageKeys;

const ITEM = { item_id: 'item-1', drive_id: 'drive-1', file_name: 'file.bin' } as DriveDeltaItem;

function make_version(size_bytes: number): DriveFileVersion {
  return { version_id: 'v2', size_bytes, last_modified_at: '2026-01-01T00:00:00Z' };
}

function make_ctx(): TenantContext {
  return {
    storage: {
      exists: vi.fn(async () => false),
      put: vi.fn(async () => undefined),
      copy: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      begin_multipart_upload: vi.fn(async () => ({
        upload_part: vi.fn(async () => 'etag'),
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
    },
    encrypt: vi.fn((data: Buffer) => data),
    create_cipher: stub_tenant_create_cipher,
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
}

/** Captures the rejection so its type and its source can both be asserted. */
async function capture_failure(promise: Promise<unknown>): Promise<VersionDownloadError> {
  const failure: unknown = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(VersionDownloadError);
  return failure as VersionDownloadError;
}

describe('version download size check (issue #616)', () => {
  it('rejects a buffered version shorter than its listed size before storing it', async () => {
    const ctx = make_ctx();
    const connector = {
      download_file_version: vi.fn(async () => Buffer.alloc(1024, 7)),
    } as unknown as DriveContentConnector;

    const failure = await capture_failure(
      store_version_content(KEYS, connector, ITEM, 'owner-1', ctx, make_version(4096)),
    );

    expect(failure.source).toBeInstanceOf(DownloadIntegrityError);
    expect(String(failure.source)).toMatch(/item-1 version v2 produced 1024 bytes, expected 4096/);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('rejects a streamed version that ends early, without promoting the staged object', async () => {
    const ctx = make_ctx();
    const connector = {
      stream_file_version: vi.fn(async () => Readable.from([Buffer.alloc(1024, 7)])),
    } as unknown as DriveContentConnector;

    const failure = await capture_failure(
      store_version_content(
        KEYS,
        connector,
        ITEM,
        'owner-1',
        ctx,
        make_version(LARGE_FILE_THRESHOLD),
      ),
    );

    expect(failure.source).toBeInstanceOf(DownloadIntegrityError);
    expect(ctx.storage.copy).not.toHaveBeenCalled();
  });

  it('stores a buffered version whose length matches its listed size', async () => {
    const ctx = make_ctx();
    const connector = {
      download_file_version: vi.fn(async () => Buffer.alloc(4096, 7)),
    } as unknown as DriveContentConnector;

    const stored = await store_version_content(
      KEYS,
      connector,
      ITEM,
      'owner-1',
      ctx,
      make_version(4096),
    );

    expect(stored.deduplicated).toBe(false);
    expect(ctx.storage.put).toHaveBeenCalledTimes(1);
  });
});
