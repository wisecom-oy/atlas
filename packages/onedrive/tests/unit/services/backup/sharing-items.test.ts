import { describe, expect, it, vi } from 'vitest';
import type {
  DrivePermission,
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveManifestEntry,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { DriveSharingCapture } from '@wisecom/atlas-drive/backup/sharing-capture';
import { DriveFolderColorCapture } from '@wisecom/atlas-drive/backup/folder-color-capture';
import { DriveItemMetadataCapture } from '@wisecom/atlas-drive/backup/item-metadata-capture';
import { digest_permissions } from '@wisecom/atlas-drive/permissions/permission-digest';
import {
  process_delta_item,
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));
vi.mock('@/services/versioning/version-sync', () => ({
  capture_owed_file_versions: vi.fn(async () => ({
    new_versions_stored: 0,
    versions_unavailable: 0,
    versions_failed: 0,
  })),
  forget_pending_versions: vi.fn(),
}));

const GRANT: DrivePermission = { roles: ['write'], granted_to: { type: 'user', id: 'jane-id' } };

const FILE: OneDriveDeltaItem = {
  item_id: 'f-1',
  drive_id: 'd1',
  kind: 'file',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: 120,
  deleted: false,
  etag: 'etag-1',
  sharing_facet: true,
};

const PREVIOUS: OneDriveManifestEntry = {
  file_id: 'f-1',
  drive_id: 'd1',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: 120,
  storage_key: 'onedrive/data/blob-1',
  checksum: 'sha-1',
  backup_at: '2026-10-01T00:00:00Z',
  change_type: 'created',
};

function known_file_state(): DriveTrackingState {
  return {
    previous_path_by_file_id: { 'f-1': '/Projects' },
    previous_name_by_file_id: { 'f-1': 'plan.docx' },
    previous_etag_by_file_id: { 'f-1': 'etag-1' },
    previous_kind_by_file_id: { 'f-1': 'file' },
    permission_digest_by_item_id: {},
  };
}

function capture(permissions: DrivePermission[], previous = PREVIOUS): DriveItemMetadataCapture {
  const sharing = new DriveSharingCapture(
    {
      fetch_item_permissions: vi.fn(
        async (_d: string, ids: readonly string[]) => new Map(ids.map((id) => [id, permissions])),
      ),
    },
    async () => previous,
  );
  return new DriveItemMetadataCapture(
    sharing,
    new DriveFolderColorCapture(stub_folder_color_reader().connector),
  );
}

async function process(
  item: OneDriveDeltaItem,
  state: DriveTrackingState,
  capture: DriveItemMetadataCapture,
) {
  return process_delta_item(
    {} as OneDriveConnector,
    item,
    'owner-1',
    'od-snap-2',
    {} as TenantContext,
    state,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
    { watermarks: {}, pending: {}, rows: new Map() },
    undefined,
    capture,
  );
}

describe('OneDrive backup of item sharing (#580)', () => {
  it('records a sharing-only change over the earlier blob without downloading', async () => {
    const state = known_file_state();

    const outcome = await process(FILE, state, capture([GRANT]));

    expect(process_backup_file).not.toHaveBeenCalled();
    expect(outcome.entry).toMatchObject({
      change_type: 'permissions_changed',
      storage_key: 'onedrive/data/blob-1',
      checksum: 'sha-1',
      permissions: [GRANT],
    });
    expect(state.permission_digest_by_item_id?.['f-1']).toBe(digest_permissions([GRANT]));
  });

  it('writes nothing for a re-presented file whose permissions did not change', async () => {
    const state = known_file_state();
    state.permission_digest_by_item_id = { 'f-1': digest_permissions([GRANT]) };

    const outcome = await process(FILE, state, capture([GRANT]));

    expect(outcome.entry).toBeUndefined();
    expect(process_backup_file).not.toHaveBeenCalled();
  });

  it('attaches permissions to the entry of a shared file whose content changed', async () => {
    vi.mocked(process_backup_file).mockResolvedValueOnce({
      storage_key: 'onedrive/data/blob-2',
      checksum: 'sha-2',
      stored: true,
      deduplicated: false,
      size_bytes: 130,
    });
    const changed = { ...FILE, etag: 'etag-2' };

    const outcome = await process(changed, known_file_state(), capture([GRANT]));

    expect(outcome.entry).toMatchObject({
      change_type: 'updated',
      storage_key: 'onedrive/data/blob-2',
      permissions: [GRANT],
    });
  });
});
