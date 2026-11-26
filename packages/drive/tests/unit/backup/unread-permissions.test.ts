import { describe, expect, it, vi } from 'vitest';
import type { DrivePermission } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';
import { DriveSharingCapture, type PermissionObservation } from '@/backup/sharing-capture';
import {
  carry_forward_unread_permissions,
  is_permission_read_failure,
  PERMISSION_READ_FAILURE_REASON,
  record_permission_read_failure,
} from '@/backup/unread-permissions';
import { digest_permissions } from '@/permissions/permission-digest';

const GRANT: DrivePermission = { roles: ['read'], granted_to: { type: 'user', id: 'jane-id' } };

const FAILED: PermissionObservation = { read: false, failed: true };

const PREVIOUS: DriveManifestEntry = {
  file_id: 'f-1',
  drive_id: 'd1',
  file_name: 'plan.docx',
  parent_path: '/Projects',
  size_bytes: 120,
  storage_key: 'onedrive/data/blob-1',
  checksum: 'sha-1',
  backup_at: '2026-10-01T00:00:00Z',
  change_type: 'created',
  permissions: [GRANT],
};

function sharing(previous: DriveManifestEntry | undefined) {
  const find_previous = vi.fn(async () => previous);
  const capture = new DriveSharingCapture({ fetch_item_permissions: vi.fn() }, find_previous);
  return { capture, find_previous };
}

describe('carry_forward_unread_permissions (#856)', () => {
  it("keeps the newest earlier entry's grants when the read failed", async () => {
    const { capture } = sharing(PREVIOUS);

    const carried = await carry_forward_unread_permissions('f-1', FAILED, capture);

    expect(carried).toEqual({
      read: true,
      permissions: [GRANT],
      digest: digest_permissions([GRANT]),
      changed: false,
    });
  });

  it('carries no grants when there is no earlier entry, or it was a deletion', async () => {
    const empty = { read: true, permissions: [], digest: digest_permissions([]), changed: false };

    expect(
      await carry_forward_unread_permissions('f-1', FAILED, sharing(undefined).capture),
    ).toEqual(empty);
    const tombstone = { ...PREVIOUS, change_type: 'deleted' as const };
    expect(
      await carry_forward_unread_permissions('f-1', FAILED, sharing(tombstone).capture),
    ).toEqual(empty);
  });

  it('returns a read or an item that needed no read as it is, without a lookup', async () => {
    const { capture, find_previous } = sharing(PREVIOUS);
    const read: PermissionObservation = {
      read: true,
      permissions: [],
      digest: 'x',
      changed: true,
    };
    const not_candidate: PermissionObservation = { read: false, failed: false };

    expect(await carry_forward_unread_permissions('f-1', read, capture)).toBe(read);
    expect(await carry_forward_unread_permissions('f-1', not_candidate, capture)).toBe(
      not_candidate,
    );
    expect(find_previous).not.toHaveBeenCalled();
  });
});

describe('record_permission_read_failure (#856)', () => {
  it('lists the item for retry and spends one attempt', () => {
    const item = { item_id: 'f-1', file_name: 'plan.docx' };

    const once = record_permission_read_failure({}, 'd1', item);
    const twice = record_permission_read_failure(once, 'd1', item);

    expect(once['f-1']).toMatchObject({
      item_id: 'f-1',
      drive_id: 'd1',
      name: 'plan.docx',
      reason: PERMISSION_READ_FAILURE_REASON,
      attempts: 1,
    });
    expect(twice['f-1']?.attempts).toBe(2);
  });

  it('is told apart from a content failure by its latest reason', () => {
    const listed = record_permission_read_failure({}, 'd1', { item_id: 'f-1', file_name: 'a' });

    expect(is_permission_read_failure(listed['f-1']!)).toBe(true);
    expect(is_permission_read_failure({ ...listed['f-1']!, reason: 'download broken' })).toBe(
      false,
    );
  });
});
