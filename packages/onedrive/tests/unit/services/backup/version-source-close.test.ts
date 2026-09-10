import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { store_version_content } from '@wisecom/atlas-drive/versioning/version-content-store';
import { LARGE_FILE_THRESHOLD } from '@wisecom/atlas-drive/backup/large-file-threshold';
import type {
  DriveContentConnector,
  DriveDeltaItem,
  DriveFileVersion,
} from '@wisecom/atlas-drive/drive-ports';
import type { DriveStorageKeys } from '@wisecom/atlas-drive/shared/storage-keys';

/**
 * Issue #344: the version upload drives its source iterator by hand, so the `for await` inside the
 * uploader never closed it. An upload that failed part way left the download running with nobody
 * reading it, holding a Graph connection until the socket timed out.
 *
 * It lives in the OneDrive package because the drive package's test aliases cannot resolve core
 * source imported through the module under test.
 */

const PART_SIZE = 8 * 1024 * 1024;
const SOURCE_CHUNK = 4 * 1024 * 1024;

const KEYS: DriveStorageKeys = {
  data_key: (owner_id: string, checksum: string) => `onedrive/data/${owner_id}/${checksum}`,
  data_prefix_for: (owner_id: string) => `onedrive/data/${owner_id}/`,
  staging_key: (owner_id: string, item_id: string) => `onedrive/staging/${owner_id}/${item_id}`,
  staging_prefix_for: (owner_id: string) => `onedrive/staging/${owner_id}/`,
} as unknown as DriveStorageKeys;

const ITEM = { item_id: 'item-1', drive_id: 'drive-1', file_name: 'Report.bin' } as DriveDeltaItem;
const VERSION = {
  version_id: 'v2',
  size_bytes: LARGE_FILE_THRESHOLD,
} as DriveFileVersion;

/** A version body that records whether the consumer closed it. */
function tracked_source(chunk_count: number): {
  connector: DriveContentConnector;
  closed: () => boolean;
  produced: () => number;
} {
  let closed = false;
  let produced = 0;
  const chunks = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      try {
        for (let index = 0; index < chunk_count; index++) {
          produced++;
          yield Buffer.alloc(SOURCE_CHUNK, index);
        }
      } finally {
        closed = true;
      }
    },
  };
  return {
    connector: {
      stream_file_version: vi.fn(async () => chunks),
    } as unknown as DriveContentConnector,
    closed: () => closed,
    produced: () => produced,
  };
}

/** A storage whose multipart upload refuses the first part it is given. */
function failing_upload_ctx(): TenantContext {
  return {
    storage: {
      begin_multipart_upload: vi.fn(async () => ({
        upload_part: vi.fn(async () => {
          throw new Error('the bucket refused the part');
        }),
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn(async () => 0),
      exists: vi.fn(async () => false),
    },
    create_cipher: stub_tenant_create_cipher,
  } as unknown as TenantContext;
}

describe('version content source lifetime (issue #344)', () => {
  it('closes the download when the upload fails part way', async () => {
    // Five chunks is more than the two parts it takes to reach the first upload_part call, so the
    // source is still producing when the storage failure arrives.
    const source = tracked_source(5);

    await expect(
      store_version_content(KEYS, source.connector, ITEM, 'owner-1', failing_upload_ctx(), VERSION),
    ).rejects.toThrow(/refused the part/);

    expect(source.closed()).toBe(true);
    expect(source.produced()).toBeLessThan(5);
    expect(source.produced() * SOURCE_CHUNK).toBeGreaterThanOrEqual(PART_SIZE);
  });
});
