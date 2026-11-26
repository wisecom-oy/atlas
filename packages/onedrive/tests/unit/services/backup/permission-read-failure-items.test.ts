import { describe, expect, it, vi } from 'vitest';
import type {
  DrivePermission,
  OneDriveConnector,
  OneDriveDeltaItem,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { PERMISSION_READ_FAILURE_REASON } from '@wisecom/atlas-drive/backup/unread-permissions';
import { digest_permissions } from '@wisecom/atlas-drive/permissions/permission-digest';
import { scan_all_drives } from '@/services/backup/backup-drive-processor';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import { build_tracking_state } from '@/services/backup/run-metadata-capture';
import type { DriveTrackingState } from '@/services/backup/delta-item-processor';

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));
vi.mock('@/services/versioning/version-sync', () => ({
  capture_owed_file_versions: vi.fn(async () => undefined),
  forget_pending_versions: vi.fn(),
}));

/** Issue #856, per item kind: a folder's failed permission read, and one beside a failed download. */
const GRANT: DrivePermission = { roles: ['read'], granted_to: { type: 'user', id: 'jane-id' } };

const TEAM: OneDriveDeltaItem = {
  item_id: 'team',
  drive_id: 'd1',
  kind: 'folder',
  file_name: 'Team',
  parent_path: '/',
  size_bytes: 0,
  deleted: false,
  sharing_facet: true,
};

const PLAN: OneDriveDeltaItem = {
  item_id: 'plan',
  drive_id: 'd1',
  kind: 'file',
  file_name: 'plan.docx',
  parent_path: '/',
  size_bytes: 10,
  deleted: false,
  etag: 'etag-1',
  sharing_facet: true,
};

async function scan(
  tracking: DriveTrackingState,
  options: { delta: OneDriveDeltaItem[]; readable: boolean; failed_items?: FailedItemLedger },
) {
  const connector = {
    fetch_delta: vi.fn(async () => ({
      drive_id: 'd1',
      items: options.delta,
      delta_link: 'next-link',
      reset_detected: false,
    })),
    fetch_item_by_id: vi.fn(async (_t: string, _o: string, _d: string, id: string) =>
      [TEAM, PLAN].find((item) => item.item_id === id),
    ),
    fetch_item_permissions: vi.fn(
      async (_d: string, ids: readonly string[]) =>
        new Map(options.readable ? ids.map((id) => [id, [GRANT]]) : []),
    ),
    ...stub_folder_color_reader().connector,
  } as unknown as OneDriveConnector;
  return scan_all_drives(
    connector,
    [{ drive_id: 'd1', drive_name: 'Documents' }],
    'tenant-1',
    'owner-1',
    'od-snap-test',
    {} as TenantContext,
    tracking,
    {},
    { delta_link_by_drive: { d1: 'saved-link' }, failed_items: options.failed_items },
    false,
    { watermarks: {}, pending: {}, rows: new Map() },
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
  );
}

describe('OneDrive permission read that fails, per item (#856)', () => {
  it('lists a shared folder, leaves its entry and digest alone, and reads it again next run', async () => {
    const tracking = build_tracking_state(undefined);
    tracking.permission_digest_by_item_id.team = 'old';

    const failed = await scan(tracking, { delta: [TEAM], readable: false });

    expect(failed.entries).toEqual([]);
    expect(failed.failed_items.team).toMatchObject({ reason: PERMISSION_READ_FAILURE_REASON });
    expect(tracking.permission_digest_by_item_id.team).toBe('old');

    const recovered = await scan(tracking, {
      delta: [],
      readable: true,
      failed_items: failed.failed_items,
    });

    expect(recovered.failed_items).toEqual({});
    expect(recovered.entries).toEqual([
      expect.objectContaining({ file_id: 'team', change_type: 'permissions_changed' }),
    ]);
    expect(tracking.permission_digest_by_item_id.team).toBe(digest_permissions([GRANT]));
  });

  it('keeps the download failure, not the permission one, when both fail', async () => {
    vi.mocked(process_backup_file).mockResolvedValueOnce(undefined);
    const tracking = build_tracking_state(undefined);

    const result = await scan(tracking, { delta: [PLAN], readable: false });

    expect(result.failed_items.plan).toMatchObject({
      reason: expect.stringContaining('Failed to process file'),
      attempts: 1,
    });
  });
});
