import { describe, expect, it, vi } from 'vitest';
import type { DriveFolderColor, DrivePermission } from '@wisecom/atlas-types';
import { stub_folder_color_reader } from '@wisecom/atlas-types/testing/stub-folder-color-reader';
import type { DriveDeltaItem } from '@/drive-ports';
import { process_folder_item, type DriveItemTracking } from '@/backup/folder-item-processor';
import { DriveSharingCapture } from '@/backup/sharing-capture';
import { DriveFolderColorCapture } from '@/backup/folder-color-capture';
import { DriveItemMetadataCapture } from '@/backup/item-metadata-capture';
import { digest_permissions } from '@/permissions/permission-digest';

const GRANT: DrivePermission = { roles: ['write'], granted_to: { type: 'user', id: 'jane-id' } };
const BLUE: DriveFolderColor = { color_hex: '6' };
const GREEN: DriveFolderColor = { color_hex: '3' };

function tracking(fields: Partial<DriveItemTracking> = {}): DriveItemTracking {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    ...fields,
  };
}

function folder(fields: Partial<DriveDeltaItem> = {}): DriveDeltaItem {
  return {
    item_id: 'f',
    drive_id: 'drive-1',
    kind: 'folder',
    file_name: 'Projects',
    parent_path: '/',
    size_bytes: 0,
    deleted: false,
    ...fields,
  };
}

interface CaptureSpec {
  /** The folder's colour as Graph reports it now; absent means uncoloured. */
  readonly color?: DriveFolderColor;
  /** The colour read fails. */
  readonly color_fails?: boolean;
  /** The folder's permissions as Graph reports them now. */
  readonly permissions?: DrivePermission[];
}

function capture(spec: CaptureSpec = {}) {
  const fetch_item_permissions = vi.fn(
    async (_d: string, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, spec.permissions ?? []])),
  );
  const reader = stub_folder_color_reader(
    spec.color ? { f: spec.color } : {},
    spec.color_fails === true ? ['f'] : [],
  );
  const metadata = new DriveItemMetadataCapture(
    new DriveSharingCapture({ fetch_item_permissions }),
    new DriveFolderColorCapture(reader.connector),
  );
  return { metadata, reader, fetch_item_permissions };
}

describe('folder colour capture in folder entries (#581)', () => {
  it('writes an entry for a newly coloured folder and records the colour in the cursor', async () => {
    const state = tracking();

    const entry = await process_folder_item(folder(), state, capture({ color: BLUE }).metadata);

    expect(entry).toMatchObject({ kind: 'folder', change_type: 'created', folder_color: BLUE });
    expect(entry?.permissions).toBeUndefined();
    expect(state.folder_color_by_item_id).toEqual({ f: BLUE });
  });

  it('writes nothing for a folder without a colour or permissions', async () => {
    const state = tracking();

    expect(await process_folder_item(folder(), state, capture().metadata)).toBeUndefined();
    expect(state.folder_color_by_item_id ?? {}).toEqual({});
  });

  it('writes nothing when delta re-presents a folder whose colour did not change', async () => {
    const state = tracking({ folder_color_by_item_id: { f: BLUE } });

    expect(await process_folder_item(folder(), state, capture({ color: BLUE }).metadata)).toBe(
      undefined,
    );
  });

  it('writes an `updated` entry when only the colour changed', async () => {
    const state = tracking({
      folder_color_by_item_id: { f: BLUE },
      previous_path_by_file_id: { f: '/' },
      previous_name_by_file_id: { f: 'Projects' },
    });

    const entry = await process_folder_item(folder(), state, capture({ color: GREEN }).metadata);

    expect(entry).toMatchObject({ change_type: 'updated', folder_color: GREEN });
    expect(state.folder_color_by_item_id).toEqual({ f: GREEN });
  });

  it('supersedes the entry when the colour is removed, so the old colour is not kept', async () => {
    const state = tracking({ folder_color_by_item_id: { f: BLUE } });

    const entry = await process_folder_item(folder(), state, capture().metadata);

    expect(entry).toMatchObject({ kind: 'folder', change_type: 'updated' });
    expect(entry?.folder_color).toBeUndefined();
    expect(state.folder_color_by_item_id).toEqual({});
  });

  it('keeps permissions on the entry when only the colour is removed', async () => {
    const state = tracking({
      folder_color_by_item_id: { f: BLUE },
      permission_digest_by_item_id: { f: digest_permissions([GRANT]) },
    });
    const shared = folder({ sharing_facet: true });

    const entry = await process_folder_item(
      shared,
      state,
      capture({ permissions: [GRANT] }).metadata,
    );

    expect(entry).toMatchObject({ change_type: 'updated', permissions: [GRANT] });
    expect(entry?.folder_color).toBeUndefined();
    expect(state.permission_digest_by_item_id?.f).toBe(digest_permissions([GRANT]));
  });

  it('writes one entry carrying both the colour and the permissions', async () => {
    const state = tracking();
    const shared = folder({ sharing_facet: true });

    const entry = await process_folder_item(
      shared,
      state,
      capture({ color: BLUE, permissions: [GRANT] }).metadata,
    );

    expect(entry).toMatchObject({
      change_type: 'created',
      folder_color: BLUE,
      permissions: [GRANT],
    });
    expect(state.folder_color_by_item_id?.f).toEqual(BLUE);
    expect(state.permission_digest_by_item_id?.f).toBe(digest_permissions([GRANT]));
  });

  it('labels a change to sharing and colour together as a permission change', async () => {
    const state = tracking({ folder_color_by_item_id: { f: BLUE } });
    const shared = folder({ sharing_facet: true });

    const entry = await process_folder_item(
      shared,
      state,
      capture({ color: GREEN, permissions: [GRANT] }).metadata,
    );

    expect(entry).toMatchObject({
      change_type: 'permissions_changed',
      folder_color: GREEN,
      permissions: [GRANT],
    });
  });

  it('does not read the permissions of a coloured folder Graph never marked as shared', async () => {
    const { metadata, fetch_item_permissions } = capture({ color: BLUE });

    await process_folder_item(folder(), tracking(), metadata);

    expect(fetch_item_permissions).not.toHaveBeenCalled();
  });

  it('tombstones a deleted coloured folder without its colour, and forgets it', async () => {
    const state = tracking({
      folder_color_by_item_id: { f: BLUE },
      previous_name_by_file_id: { f: 'Projects' },
    });
    const deleted = folder({ kind: 'file', file_name: '', deleted: true });

    const entry = await process_folder_item(deleted, state, capture().metadata);

    expect(entry).toMatchObject({ change_type: 'deleted', kind: 'folder', file_name: 'Projects' });
    expect(entry?.folder_color).toBeUndefined();
    expect(state.folder_color_by_item_id).toEqual({});
  });

  it('moves a colour-only entry with its folder', async () => {
    const state = tracking({
      folder_color_by_item_id: { f: BLUE },
      previous_path_by_file_id: { f: '/Old' },
      previous_name_by_file_id: { f: 'Projects' },
    });

    const entry = await process_folder_item(
      folder({ parent_path: '/New' }),
      state,
      capture({ color: BLUE }).metadata,
    );

    expect(entry).toMatchObject({ change_type: 'moved', parent_path: '/New', folder_color: BLUE });
  });
});

describe('a failed folder colour read (#581)', () => {
  it('writes nothing and keeps the recorded colour, so the next read compares against it', async () => {
    const state = tracking({ folder_color_by_item_id: { f: BLUE } });

    const entry = await process_folder_item(
      folder(),
      state,
      capture({ color_fails: true }).metadata,
    );

    expect(entry).toBeUndefined();
    expect(state.folder_color_by_item_id).toEqual({ f: BLUE });
  });

  it('still records a permission change, carrying the colour the cursor recorded', async () => {
    const state = tracking({ folder_color_by_item_id: { f: BLUE } });
    const shared = folder({ sharing_facet: true });

    const entry = await process_folder_item(
      shared,
      state,
      capture({ color_fails: true, permissions: [GRANT] }).metadata,
    );

    expect(entry).toMatchObject({
      change_type: 'permissions_changed',
      folder_color: BLUE,
      permissions: [GRANT],
    });
    expect(state.folder_color_by_item_id).toEqual({ f: BLUE });
  });
});
