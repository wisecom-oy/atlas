import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { process_drive_backup_file } from '@wisecom/atlas-drive/backup/file-processor';
import type { DriveContentConnector, DriveDeltaItem } from '@wisecom/atlas-drive/drive-ports';
import type { DriveLargeFileDeps } from '@wisecom/atlas-drive/backup/large-file-pipeline';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { LARGE_FILE_THRESHOLD } from '@wisecom/atlas-drive/backup/large-file-threshold';

/**
 * Issue #344: once the download became abortable, a cancelled transfer looked exactly like a file
 * that would not download. Both providers write that into the failed-item ledger with an
 * incremented attempt count, five attempts exhaust the budget, and delta never re-presents an
 * unchanged item, so cancelling a run five times could skip a large file permanently.
 */

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  file_name: 'Report.bin',
  parent_path: '/Documents',
  size_bytes: LARGE_FILE_THRESHOLD,
  kind: 'file',
  download_url: 'https://cdn.test/item-1',
} as DriveDeltaItem;

const KEYS = {
  data_key: (owner_id: string, checksum: string) => `onedrive/data/${owner_id}/${checksum}`,
  data_prefix_for: (owner_id: string) => `onedrive/data/${owner_id}/`,
  staging_key: (owner_id: string, item_id: string) => `onedrive/staging/${owner_id}/${item_id}`,
  staging_prefix_for: (owner_id: string) => `onedrive/staging/${owner_id}/`,
};

/** A chunk source that fails the way an aborted fetch does, part way through the file. */
function deps_failing_with(reason: Error): DriveLargeFileDeps {
  return {
    keys: KEYS,
    fetch_chunks: () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        yield Buffer.alloc(1024, 1);
        throw reason;
      },
    }),
  } as unknown as DriveLargeFileDeps;
}

function make_ctx(): TenantContext {
  return {
    storage: {
      begin_multipart_upload: vi.fn(async () => ({
        upload_part: vi.fn(async () => 'etag'),
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

const CONNECTOR = {
  resolve_download_url: vi.fn(async () => 'https://cdn.test/item-1'),
} as unknown as DriveContentConnector & { resolve_download_url: () => Promise<string> };

describe('a cancelled large-file download (issue #344)', () => {
  it('reaches the caller instead of being reported as a file that could not be downloaded', async () => {
    const cancel = new AbortController();
    cancel.abort(new Error('run cancelled'));

    await expect(
      process_drive_backup_file(
        deps_failing_with(new Error('run cancelled')),
        CONNECTOR,
        ITEM,
        'owner-1',
        make_ctx(),
        cancel.signal,
      ),
    ).rejects.toThrow(/run cancelled/);
  });

  it('still reports a genuine download failure as a skip the ledger can record', async () => {
    const result = await process_drive_backup_file(
      deps_failing_with(new Error('the CDN closed the connection')),
      CONNECTOR,
      ITEM,
      'owner-1',
      make_ctx(),
    );

    expect(result).toBeUndefined();
  });
});
