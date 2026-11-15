import { describe, expect, it, vi } from 'vitest';
import type { DrivePermission } from '@wisecom/atlas-types';
import type { DriveDeltaItem, DriveManifestEntry } from '@/drive-ports';
import { DriveSharingCapture, type PermissionObservation } from '@/backup/sharing-capture';
import { plan_sharing_only_change } from '@/backup/sharing-only-change';

const GRANT: DrivePermission = { roles: ['read'], granted_to: { type: 'user', id: 'jane-id' } };
const CHANGED: PermissionObservation = {
  read: true,
  permissions: [GRANT],
  digest: 'd',
  changed: true,
};

const ITEM: DriveDeltaItem = {
  item_id: 'f-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: 999,
  deleted: false,
  etag: 'e1',
};

const PREVIOUS: DriveManifestEntry = {
  file_id: 'f-1',
  drive_id: 'drive-1',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: 120,
  storage_key: 'onedrive/data/blob',
  checksum: 'sha',
  backup_at: '2026-11-01T00:00:00Z',
  change_type: 'created',
};

function sharing(previous: DriveManifestEntry | undefined): DriveSharingCapture {
  return new DriveSharingCapture({ fetch_item_permissions: vi.fn() }, async () => previous);
}

describe('plan_sharing_only_change (#580)', () => {
  it('reuses the earlier blob, so a sharing change downloads nothing', async () => {
    const plan = await plan_sharing_only_change(ITEM, CHANGED, sharing(PREVIOUS));

    expect(plan).toEqual({
      kind: 'entry',
      entry: expect.objectContaining({
        file_id: 'f-1',
        change_type: 'permissions_changed',
        storage_key: 'onedrive/data/blob',
        checksum: 'sha',
        size_bytes: 120,
        permissions: [GRANT],
      }),
    });
  });

  it('records nothing when the permissions did not change or were not read', async () => {
    expect(
      await plan_sharing_only_change(ITEM, { ...CHANGED, changed: false }, sharing(PREVIOUS)),
    ).toEqual({ kind: 'none' });
    expect(await plan_sharing_only_change(ITEM, { read: false }, sharing(PREVIOUS))).toEqual({
      kind: 'none',
    });
  });

  it('falls back to a download when no earlier blob is known', async () => {
    const { storage_key: _key, ...tombstone } = PREVIOUS;
    expect(await plan_sharing_only_change(ITEM, CHANGED, sharing(undefined))).toEqual({
      kind: 'download',
    });
    expect(
      await plan_sharing_only_change(
        ITEM,
        CHANGED,
        sharing({ ...tombstone, change_type: 'deleted' }),
      ),
    ).toEqual({ kind: 'download' });
  });
});
