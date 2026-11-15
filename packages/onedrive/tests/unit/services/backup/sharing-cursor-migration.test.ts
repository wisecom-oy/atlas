import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { append_recrawl_tombstones } from '@wisecom/atlas-drive/backup/recrawl-tombstones';
import { scan_all_drives } from '@/services/backup/backup-drive-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import type { DriveTrackingState } from '@/services/backup/delta-item-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

/**
 * Issue #580. A saved delta link pins its `$select`, so a cursor written before `shared` joined
 * never marks shared items. Such a cursor is enumerated afresh once, keeping file tracking: the
 * unchanged files must not be downloaded again, and a file deleted since the last run must still
 * get its tombstone, because a fresh listing reports what exists, not what was removed.
 */

const KEPT: OneDriveDeltaItem = {
  item_id: 'kept',
  drive_id: 'd1',
  kind: 'file',
  file_name: 'kept.docx',
  parent_path: '/Documents',
  size_bytes: 10,
  deleted: false,
  etag: 'etag-kept',
};

function tracking(): DriveTrackingState {
  return {
    previous_path_by_file_id: { kept: '/Documents', gone: '/Documents' },
    previous_name_by_file_id: { kept: 'kept.docx', gone: 'gone.docx' },
    previous_etag_by_file_id: { kept: 'etag-kept', gone: 'etag-gone' },
    previous_kind_by_file_id: { kept: 'file', gone: 'file' },
  };
}

function previous_entry(file_id: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'd1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: 10,
    storage_key: `data/${file_id}`,
    checksum: 'sha',
    backup_at: '2026-10-01T00:00:00Z',
    change_type: 'created',
  };
}

async function scan_pre_sharing_cursor() {
  const connector = {
    fetch_delta: vi.fn(async () => ({
      drive_id: 'd1',
      items: [KEPT],
      delta_link: 'fresh-link',
      reset_detected: false,
      full_enumeration: true,
    })),
  } as unknown as OneDriveConnector;
  return scan_all_drives(
    connector,
    [{ drive_id: 'd1', drive_name: 'Documents' }],
    'tenant-1',
    'owner-1',
    'od-snap-test',
    {} as TenantContext,
    tracking(),
    {},
    { delta_link_by_drive: { d1: 'old-link-without-sharing' } },
    false,
    { watermarks: {}, rows: new Map() },
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
  );
}

describe('re-enumerating a pre-sharing cursor (#580)', () => {
  it('does not download files whose content did not change', async () => {
    const scan = await scan_pre_sharing_cursor();

    expect(process_backup_file).not.toHaveBeenCalled();
    expect(scan.entries).toEqual([]);
    expect(scan.recrawls.map((recrawl) => recrawl.drive_id)).toEqual(['d1']);
  });

  it('still tombstones a file deleted since the last run', async () => {
    const scan = await scan_pre_sharing_cursor();
    const earlier = {
      snapshot_id: 'od-snap-1',
      created_at: new Date('2026-10-01T00:00:00Z'),
      entries: [previous_entry('kept'), previous_entry('gone')],
    } as OneDriveSnapshotManifest;

    await append_recrawl_tombstones(scan, async () => readable_manifests([earlier]));

    expect(scan.entries).toEqual([
      expect.objectContaining({ file_id: 'gone', change_type: 'deleted' }),
    ]);
    expect(scan.deleted_items).toBe(1);
  });
});
