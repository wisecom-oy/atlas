import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  assert_stream_within_part_limit,
  max_streamed_object_bytes,
} from '@wisecom/atlas-core/services/shared/multipart-part-plan';
import { stream_to_content_addressed_storage } from '@wisecom/atlas-core/services/shared/stream-encrypt-upload';
import type { DriveContentConnector, DriveDeltaItem, DriveFileVersion } from '@/drive-ports';
import { build_drive_storage_keys } from '@/shared/storage-keys';
import { sync_file_versions } from '@/versioning/version-sync';

// Issue #925: a historical version too large for the multipart part limit used to fail the whole
// drive, since only a Graph failure was a version's own. It is counted unavailable, the watermark
// moves past it, and its download is never opened. A version stream that outgrows its plan is a bad
// download, retried next run.

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@wisecom/atlas-core/services/shared/stream-encrypt-upload', () => ({
  stream_to_content_addressed_storage: vi.fn(),
}));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  file_name: 'Archive.bin',
} as DriveDeltaItem;

function version_of(size_bytes: number): DriveFileVersion {
  return { version_id: '1.0', last_modified_at: '2026-01-01T00:00:00Z', size_bytes };
}

function connector_listing(version: DriveFileVersion): DriveContentConnector {
  return {
    list_file_versions: vi.fn(async () => [version]),
    stream_file_version: vi.fn(async () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {},
    })),
  } as unknown as DriveContentConnector;
}

function sync(connector: DriveContentConnector) {
  return sync_file_versions(
    build_drive_storage_keys('onedrive'),
    connector,
    ITEM,
    'owner-1',
    'snap-1',
    {} as TenantContext,
    {},
  );
}

describe('a historical version and the multipart part limit (issue #925)', () => {
  it('counts a version over the largest size unavailable without opening its download', async () => {
    const connector = connector_listing(version_of(max_streamed_object_bytes() + 1));

    const outcome = await sync(connector);

    expect(outcome).toMatchObject({ versions_unavailable: 1, versions_failed: 0, records: [] });
    expect(outcome.next_watermark).toBeDefined();
    expect(connector.stream_file_version).not.toHaveBeenCalled();
    expect(stream_to_content_addressed_storage).not.toHaveBeenCalled();
  });

  it('passes the listed size to the stream so it plans the part size', async () => {
    const connector = connector_listing(version_of(max_streamed_object_bytes()));
    vi.mocked(stream_to_content_addressed_storage).mockResolvedValueOnce({
      checksum: 'c',
      storage_key: 'k',
      stored: true,
      deduplicated: false,
    });

    const outcome = await sync(connector);

    expect(outcome.new_versions_stored).toBe(1);
    expect(vi.mocked(stream_to_content_addressed_storage).mock.calls[0]?.[2]).toMatchObject({
      listed_bytes: max_streamed_object_bytes(),
    });
  });

  it('fails a version whose stream outgrew the plan, keeping the watermark for a retry', async () => {
    let overflow: unknown;
    try {
      assert_stream_within_part_limit(8 * 1024 * 1024 + 1, 8 * 1024 * 1024, 1);
    } catch (err) {
      overflow = err;
    }
    vi.mocked(stream_to_content_addressed_storage).mockRejectedValueOnce(overflow);

    const outcome = await sync(connector_listing(version_of(64 * 1024 * 1024)));

    expect(outcome).toMatchObject({ versions_failed: 1, versions_unavailable: 0 });
    expect(outcome.next_watermark).toBeUndefined();
  });
});
