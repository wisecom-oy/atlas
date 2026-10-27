import { describe, expect, it, vi } from 'vitest';
import type { OneDriveConnector, OneDriveDeltaItem, TenantContext } from '@wisecom/atlas-types';
import { scan_all_drives } from '@/services/backup/backup-drive-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import type { DriveTrackingState } from '@/services/backup/delta-item-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));
vi.mock('@/services/versioning/version-sync', () => ({
  sync_file_versions: vi.fn(async () => ({ stored: 0, unavailable: 0, failed: 0, rows: [] })),
  collect_run_versions: vi.fn(),
}));

/**
 * Issue #433: a drive that throws mid-batch loses its entries and keeps its old delta link, but
 * the files it processed before the throw used to leave their ETags in the shared tracking state.
 * The replayed delta then classified them as unchanged and no manifest ever referenced them.
 */

const ITEMS = ['a', 'b'].map((item_id) => ({
  item_id,
  drive_id: 'd1',
  file_name: item_id,
  parent_path: '/Documents',
  size_bytes: 10,
  kind: 'file',
  etag: `etag-${item_id}`,
  download_url: `https://cdn.test/${item_id}`,
})) as OneDriveDeltaItem[];

function stored(item_id: string): Awaited<ReturnType<typeof process_backup_file>> {
  return {
    storage_key: `k/${item_id}`,
    checksum: `c-${item_id}`,
    stored: true,
    deduplicated: false,
  };
}

async function run(tracking_state: DriveTrackingState) {
  const connector = {
    fetch_delta: vi.fn(async () => ({ items: ITEMS, delta_link: 'next', reset_detected: false })),
  } as unknown as OneDriveConnector;
  const links: Record<string, string> = {};
  const result = await scan_all_drives(
    connector,
    [{ drive_id: 'd1', drive_name: 'Documents' }],
    'tenant-1',
    'owner-1',
    'od-snap-test',
    {} as TenantContext,
    tracking_state,
    links,
    { delta_link_by_drive: {} },
    false,
    { watermarks: {}, rows: new Map() },
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
  );
  return { result, links };
}

describe('a drive that fails mid-batch (issue #433)', () => {
  it('records on the next run every file the failed run did not', async () => {
    const tracking_state: DriveTrackingState = {
      previous_path_by_file_id: {},
      previous_name_by_file_id: {},
      previous_etag_by_file_id: {},
      previous_kind_by_file_id: {},
    };

    vi.mocked(process_backup_file)
      .mockResolvedValueOnce(stored('a'))
      .mockRejectedValueOnce(new Error('S3 PutObject: 503 SlowDown'));
    const first = await run(tracking_state);
    expect(first.result.entries).toEqual([]);
    expect(first.result.errors).toHaveLength(1);
    expect(first.links).toEqual({});
    expect(tracking_state.previous_etag_by_file_id).toEqual({});

    vi.mocked(process_backup_file).mockImplementation(async (_c, item: OneDriveDeltaItem) =>
      stored(item.item_id),
    );
    const second = await run(tracking_state);
    expect(second.result.errors).toEqual([]);
    expect(second.result.entries.map((entry) => entry.file_id).sort()).toEqual(['a', 'b']);
    expect(tracking_state.previous_etag_by_file_id).toEqual({ a: 'etag-a', b: 'etag-b' });
  });
});
