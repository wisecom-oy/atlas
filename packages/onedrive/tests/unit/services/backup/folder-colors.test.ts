import { describe, expect, it, vi } from 'vitest';
import type {
  DriveFolderColor,
  OneDriveConnector,
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { scan_all_drives } from '@/services/backup/backup-drive-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import { build_tracking_state } from '@/services/backup/run-metadata-capture';
import type { DriveTrackingState } from '@/services/backup/delta-item-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));
vi.mock('@/services/versioning/version-sync', () => ({
  capture_owed_file_versions: vi.fn(async () => ({
    new_versions_stored: 0,
    versions_unavailable: 0,
    versions_failed: 0,
  })),
  forget_pending_versions: vi.fn(),
}));

const BLUE: DriveFolderColor = { color_hex: '6' };

function folder(item_id: string, fields: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: 'd1',
    kind: 'folder',
    file_name: item_id,
    parent_path: '/',
    size_bytes: 0,
    deleted: false,
    ...fields,
  };
}

const CHANGED_FILE: OneDriveDeltaItem = {
  item_id: 'file-1',
  drive_id: 'd1',
  kind: 'file',
  file_name: 'plan.docx',
  parent_path: '/Coloured',
  size_bytes: 10,
  deleted: false,
  etag: 'etag-2',
};

const DELTA = [
  folder('root', { is_root: true }),
  folder('Coloured'),
  folder('Plain'),
  CHANGED_FILE,
];

function empty_tracking(): DriveTrackingState {
  return build_tracking_state(undefined);
}

async function scan(tracking: DriveTrackingState, unreadable: string[] = []) {
  const reader = stub_folder_color_reader({ Coloured: BLUE }, unreadable);
  const connector = {
    fetch_delta: vi.fn(async () => ({
      drive_id: 'd1',
      items: DELTA,
      delta_link: 'next-link',
      reset_detected: false,
    })),
    fetch_item_permissions: vi.fn(async () => new Map()),
    ...reader.connector,
  } as unknown as OneDriveConnector;
  const result = await scan_all_drives(
    connector,
    [{ drive_id: 'd1', drive_name: 'Documents' }],
    'tenant-1',
    'owner-1',
    'od-snap-test',
    {} as TenantContext,
    tracking,
    {},
    { delta_link_by_drive: { d1: 'saved-link' } },
    false,
    { watermarks: {}, pending: {}, rows: new Map() },
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
  );
  return { result, reader };
}

vi.mocked(process_backup_file).mockResolvedValue({
  storage_key: 'onedrive/data/blob',
  checksum: 'sha',
  stored: true,
  deduplicated: false,
  size_bytes: 10,
});

describe('OneDrive backup of folder colours (#581)', () => {
  it('reads every live folder delta returned in one batched call and records the coloured one', async () => {
    const tracking = empty_tracking();

    const { result, reader } = await scan(tracking);

    expect(reader.calls).toEqual([['Coloured', 'Plain']]);
    const folders = result.entries.filter((entry) => entry.kind === 'folder');
    expect(folders).toEqual([
      expect.objectContaining({ file_id: 'Coloured', change_type: 'created', folder_color: BLUE }),
    ]);
    expect(tracking.folder_color_by_item_id).toEqual({ Coloured: BLUE });
  });

  it('writes no folder entry when the next run sees the same colour', async () => {
    const tracking = empty_tracking();
    await scan(tracking);

    const { result } = await scan(tracking);

    expect(result.entries.filter((entry) => entry.kind === 'folder')).toEqual([]);
  });

  it('keeps backing up content when the colour reads fail', async () => {
    const { result } = await scan(empty_tracking(), ['Coloured', 'Plain']);

    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => entry.file_id)).toEqual(['file-1']);
    expect(result.files_stored).toBe(1);
  });
});

describe('OneDrive cursors and folder colours (#581)', () => {
  it('starts an empty colour map for a cursor written before colours were captured', () => {
    const legacy = {
      previous_path_by_file_id: {},
      previous_name_by_file_id: {},
      previous_etag_by_file_id: {},
      previous_kind_by_file_id: {},
    } as unknown as OneDriveDeltaCursor;

    expect(build_tracking_state(legacy).folder_color_by_item_id).toEqual({});
  });

  it('copies the colour map, so a failed run cannot change the stored cursor', () => {
    const stored = { folder_color_by_item_id: { a: BLUE } } as unknown as OneDriveDeltaCursor;

    const state = build_tracking_state(stored);
    state.folder_color_by_item_id.b = BLUE;

    expect(stored.folder_color_by_item_id).toEqual({ a: BLUE });
  });
});
