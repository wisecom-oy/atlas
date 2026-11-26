import { describe, expect, it, vi } from 'vitest';
import type {
  DrivePermission,
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { DriveSharingCapture } from '@wisecom/atlas-drive/backup/sharing-capture';
import { DriveFolderColorCapture } from '@wisecom/atlas-drive/backup/folder-color-capture';
import { DriveItemMetadataCapture } from '@wisecom/atlas-drive/backup/item-metadata-capture';
import {
  process_delta_item,
  type FileTrackingState,
  type LibraryProcessingState,
} from '@/services/backup/library-item-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

const GRANT: DrivePermission = { roles: ['read'], granted_to: { type: 'group', id: 'group-id' } };

function tracking(): FileTrackingState {
  return {
    previous_path_by_file_id: { 'f-1': '/General' },
    previous_name_by_file_id: { 'f-1': 'budget.xlsx' },
    previous_etag_by_file_id: { 'f-1': 'etag-1' },
    previous_kind_by_file_id: { 'f-1': 'file' },
    permission_digest_by_item_id: {},
  };
}

function library_state(): LibraryProcessingState {
  return {
    library_entries: [],
    library_name: 'Documents',
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items: {},
    failed_item_ids: new Set(),
  };
}

const sharing_capture = new DriveSharingCapture(
  {
    fetch_item_permissions: vi.fn(
      async (_d: string, ids: readonly string[]) => new Map(ids.map((id) => [id, [GRANT]])),
    ),
  },
  async (file_id) => ({
    file_id,
    drive_id: 'lib-1',
    file_name: 'budget.xlsx',
    parent_path: '/General',
    size_bytes: 50,
    storage_key: 'sharepoint/data/blob',
    checksum: 'sha',
    backup_at: '2026-10-01T00:00:00Z',
    change_type: 'created',
  }),
);
const capture = new DriveItemMetadataCapture(
  sharing_capture,
  new DriveFolderColorCapture(stub_folder_color_reader().connector),
);

async function process(item: SharePointDeltaItem, state: LibraryProcessingState): Promise<void> {
  await process_delta_item(
    {} as SharePointSiteConnector,
    item,
    'site-1',
    'sp-snap-2',
    {} as TenantContext,
    tracking(),
    state,
    { watermarks: {}, pending: {}, rows: new Map() },
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    undefined,
    capture,
  );
}

describe('SharePoint library item sharing (#580)', () => {
  it('records a sharing-only change over the earlier blob', async () => {
    const state = library_state();

    await process(
      {
        item_id: 'f-1',
        drive_id: 'lib-1',
        kind: 'file',
        file_name: 'budget.xlsx',
        parent_path: '/General',
        size_bytes: 50,
        deleted: false,
        etag: 'etag-1',
        sharing_facet: true,
      },
      state,
    );

    expect(process_backup_file).not.toHaveBeenCalled();
    expect(state.library_entries).toEqual([
      expect.objectContaining({
        change_type: 'permissions_changed',
        storage_key: 'sharepoint/data/blob',
        library_name: 'Documents',
        permissions: [GRANT],
      }),
    ]);
  });
});
