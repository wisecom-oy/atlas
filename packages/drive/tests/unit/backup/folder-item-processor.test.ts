import { describe, expect, it, vi } from 'vitest';
import type { DrivePermission } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import { process_folder_item, type DriveItemTracking } from '@/backup/folder-item-processor';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import { DriveSharingCapture } from '@/backup/sharing-capture';
import { DriveFolderColorCapture } from '@/backup/folder-color-capture';
import { DriveItemMetadataCapture } from '@/backup/item-metadata-capture';
import { digest_permissions } from '@/permissions/permission-digest';

const GRANT: DrivePermission = { roles: ['write'], granted_to: { type: 'user', id: 'jane-id' } };

function tracking(fields: Partial<DriveItemTracking> = {}): DriveItemTracking {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    permission_digest_by_item_id: {},
    ...fields,
  };
}

function item(fields: Partial<DriveDeltaItem>): DriveDeltaItem {
  return {
    item_id: 'x',
    drive_id: 'drive-1',
    kind: 'folder',
    file_name: 'Projects',
    parent_path: '/',
    size_bytes: 0,
    deleted: false,
    ...fields,
  };
}

/** A capture whose permission reads answer `permissions` (undefined: they fail) and no folder is coloured. */
function capture(permissions: DrivePermission[] | undefined): DriveItemMetadataCapture {
  const sharing = new DriveSharingCapture({
    fetch_item_permissions: vi.fn(async (_d: string, ids: readonly string[]) =>
      permissions === undefined ? new Map() : new Map(ids.map((id) => [id, permissions])),
    ),
  });
  return new DriveItemMetadataCapture(
    sharing,
    new DriveFolderColorCapture(stub_folder_color_reader().connector),
  );
}

describe('process_folder_item (#580)', () => {
  it('records a folder only when it carries permissions of its own', async () => {
    const shared = item({ item_id: 'f', sharing_facet: true });
    expect(await process_folder_item(shared, tracking(), capture([]))).toBeUndefined();

    const state = tracking();
    const entry = await process_folder_item(shared, state, capture([GRANT]));
    expect(entry).toMatchObject({
      file_id: 'f',
      kind: 'folder',
      change_type: 'created',
      permissions: [GRANT],
    });
    expect(state.permission_digest_by_item_id?.f).toBe(digest_permissions([GRANT]));
  });

  it('writes nothing for an unchanged folder, and never reads an unshared one', async () => {
    const fetcher = capture([GRANT]);
    const digest = digest_permissions([GRANT]);
    const state = tracking({
      permission_digest_by_item_id: { f: digest },
      previous_path_by_file_id: { f: '/' },
      previous_name_by_file_id: { f: 'Projects' },
    });

    expect(await process_folder_item(item({ item_id: 'f' }), state, fetcher)).toBeUndefined();
    expect(
      await process_folder_item(item({ item_id: 'plain' }), tracking(), fetcher),
    ).toBeUndefined();
  });

  it('supersedes the old entry when sharing is removed, so restore stops reapplying it', async () => {
    const state = tracking({ permission_digest_by_item_id: { f: digest_permissions([GRANT]) } });

    const entry = await process_folder_item(
      item({ item_id: 'f', sharing_facet: true }),
      state,
      capture([]),
    );

    expect(entry).toMatchObject({ kind: 'folder', change_type: 'permissions_changed' });
    expect(entry?.permissions).toBeUndefined();
    expect(state.permission_digest_by_item_id?.f).toBeUndefined();
  });

  it('moves the entry with a folder that was moved', async () => {
    const state = tracking({
      permission_digest_by_item_id: { f: digest_permissions([GRANT]) },
      previous_path_by_file_id: { f: '/Old' },
      previous_name_by_file_id: { f: 'Projects' },
    });

    const entry = await process_folder_item(
      item({ item_id: 'f', parent_path: '/New' }),
      state,
      capture([GRANT]),
    );

    expect(entry).toMatchObject({ change_type: 'moved', parent_path: '/New' });
  });

  it('tombstones a deleted folder that had an entry, and ignores one that never did', async () => {
    const state = tracking({
      permission_digest_by_item_id: { f: 'digest' },
      previous_name_by_file_id: { f: 'Projects' },
    });
    const deleted = item({ item_id: 'f', kind: 'file', file_name: '', deleted: true });

    expect(await process_folder_item(deleted, state, capture([]))).toMatchObject({
      kind: 'folder',
      change_type: 'deleted',
      file_name: 'Projects',
    });
    expect(
      await process_folder_item(item({ item_id: 'g', deleted: true }), tracking(), capture([])),
    ).toBeUndefined();
  });

  it('keeps the existing entry when the permission read fails', async () => {
    const state = tracking({ permission_digest_by_item_id: { f: 'digest' } });
    const entry = await process_folder_item(item({ item_id: 'f' }), state, capture(undefined));
    expect(entry).toBeUndefined();
    expect(state.permission_digest_by_item_id?.f).toBe('digest');
  });

  it('never records the drive root', async () => {
    const root = item({ item_id: 'root', is_root: true, sharing_facet: true });
    expect(await process_folder_item(root, tracking(), capture([GRANT]))).toBeUndefined();
  });
});
