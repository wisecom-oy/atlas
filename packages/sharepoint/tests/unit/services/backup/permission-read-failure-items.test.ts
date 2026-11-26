import { describe, expect, it, vi } from 'vitest';
import type {
  DrivePermission,
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { create_item_metadata_capture } from '@wisecom/atlas-drive/backup/item-metadata-capture';
import { PERMISSION_READ_FAILURE_REASON } from '@wisecom/atlas-drive/backup/unread-permissions';
import { digest_permissions } from '@wisecom/atlas-drive/permissions/permission-digest';
import {
  process_item_guarded,
  type FileTrackingState,
  type LibraryProcessingState,
} from '@/services/backup/library-item-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));
vi.mock('@/services/versioning/version-sync', () => ({
  capture_owed_file_versions: vi.fn(async () => undefined),
  forget_pending_versions: vi.fn(),
}));

/** Issue #856, per item kind: a folder's failed permission read, and one beside a failed download. */
const GRANT: DrivePermission = { roles: ['read'], granted_to: { type: 'group', id: 'group-id' } };

const TEAM: SharePointDeltaItem = {
  item_id: 'team',
  drive_id: 'lib-1',
  kind: 'folder',
  file_name: 'Team',
  parent_path: '/',
  size_bytes: 0,
  deleted: false,
  sharing_facet: true,
};

const BUDGET: SharePointDeltaItem = {
  item_id: 'budget',
  drive_id: 'lib-1',
  kind: 'file',
  file_name: 'budget.xlsx',
  parent_path: '/',
  size_bytes: 50,
  deleted: false,
  etag: 'etag-1',
  sharing_facet: true,
};

function tracking(): FileTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    permission_digest_by_item_id: { team: 'old' },
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

async function process(
  item: SharePointDeltaItem,
  file_tracking: FileTrackingState,
  state: LibraryProcessingState,
  readable: boolean,
): Promise<void> {
  const capture = create_item_metadata_capture({
    fetch_item_permissions: vi.fn(
      async (_d: string, ids: readonly string[]) =>
        new Map(readable ? ids.map((id) => [id, [GRANT]]) : []),
    ),
    ...stub_folder_color_reader().connector,
  });
  await process_item_guarded(
    {} as SharePointSiteConnector,
    item,
    'site-1',
    'sp-snap-2',
    {} as TenantContext,
    file_tracking,
    state,
    { watermarks: {}, pending: {}, rows: new Map() },
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    undefined,
    capture,
  );
}

describe('SharePoint permission read that fails, per item (#856)', () => {
  it('lists a shared folder, leaves its entry and digest alone, and clears it once read', async () => {
    const file_tracking = tracking();
    const state = library_state();

    await process(TEAM, file_tracking, state, false);

    expect(state.library_entries).toEqual([]);
    expect(state.failed_items.team).toMatchObject({ reason: PERMISSION_READ_FAILURE_REASON });
    expect(state.failed_item_ids.has('team')).toBe(false);
    expect(file_tracking.permission_digest_by_item_id?.team).toBe('old');

    await process(TEAM, file_tracking, state, true);

    expect(state.failed_items).toEqual({});
    expect(state.library_entries).toEqual([
      expect.objectContaining({ file_id: 'team', change_type: 'permissions_changed' }),
    ]);
    expect(file_tracking.permission_digest_by_item_id?.team).toBe(digest_permissions([GRANT]));
  });

  it('keeps the download failure, not the permission one, when both fail', async () => {
    vi.mocked(process_backup_file).mockResolvedValueOnce(undefined);
    const state = library_state();

    await process(BUDGET, tracking(), state, false);

    expect(state.failed_items.budget).toMatchObject({
      reason: 'file content could not be downloaded',
      attempts: 1,
    });
  });
});
