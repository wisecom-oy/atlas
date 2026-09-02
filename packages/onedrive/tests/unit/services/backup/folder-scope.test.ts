/**
 * Folder-scoped OneDrive backup.
 *
 * The delta link is drive-wide, so the dangerous case is not the filtering, it is resuming a link
 * across a scope change: changes filtered out under the old scope would be skipped forever. The
 * service therefore re-crawls whenever the scope differs from the one recorded in the cursor.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { is_within_folder_scope, normalize_folder_scope } from '@/services/backup/folder-scope';
import { OneDriveBackupService } from '@/services/backup/backup.service';

const DRIVE_ID = 'd1';
const OWNER_ID = 'owner-1';

function make_item(item_id: string, parent_path: string, deleted = false): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: DRIVE_ID,
    kind: 'file',
    file_name: `${item_id}.txt`,
    parent_path,
    size_bytes: 8,
    deleted,
    etag: `etag-${item_id}`,
  };
}

describe('normalize_folder_scope', () => {
  it('adds the leading slash and drops a trailing one', () => {
    expect(normalize_folder_scope('E2E/')).toBe('/E2E');
    expect(normalize_folder_scope('/E2E')).toBe('/E2E');
    expect(normalize_folder_scope(' /E2E/Nested ')).toBe('/E2E/Nested');
  });

  it('treats the drive root and blanks as no scope at all', () => {
    expect(normalize_folder_scope('/')).toBeUndefined();
    expect(normalize_folder_scope('')).toBeUndefined();
    expect(normalize_folder_scope(undefined)).toBeUndefined();
  });
});

describe('is_within_folder_scope', () => {
  it('includes files directly in the folder and below it', () => {
    expect(is_within_folder_scope(make_item('a', '/E2E'), '/E2E', {})).toBe(true);
    expect(is_within_folder_scope(make_item('b', '/E2E/Nested'), '/E2E', {})).toBe(true);
  });

  it('excludes everything outside, including a sibling with the same prefix', () => {
    expect(is_within_folder_scope(make_item('c', '/Other'), '/E2E', {})).toBe(false);
    expect(is_within_folder_scope(make_item('d', '/'), '/E2E', {})).toBe(false);
    // `/E2E-archive` must not match `/E2E`: prefix matching has to respect the separator.
    expect(is_within_folder_scope(make_item('e', '/E2E-archive'), '/E2E', {})).toBe(false);
  });

  it('judges a deletion by its remembered path, since Graph omits the parent', () => {
    const removed = make_item('f', '', true);

    expect(is_within_folder_scope(removed, '/E2E', { f: '/E2E' })).toBe(true);
    expect(is_within_folder_scope(removed, '/E2E', { f: '/Other' })).toBe(false);
  });
});

interface Harness {
  service: OneDriveBackupService;
  fetch_delta: ReturnType<typeof vi.fn>;
  saved: OneDriveDeltaCursor[];
  downloaded: string[];
}

function make_harness(options: {
  delta_items: OneDriveDeltaItem[];
  stored_cursor?: OneDriveDeltaCursor;
}): Harness {
  const downloaded: string[] = [];
  const saved: OneDriveDeltaCursor[] = [];

  const fetch_delta = vi.fn(async () => ({
    drive_id: DRIVE_ID,
    delta_link: 'delta-2',
    items: options.delta_items,
    reset_detected: false,
  }));

  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: DRIVE_ID, drive_name: 'Documents' }]),
    fetch_delta,
    fetch_item_by_id: vi.fn(),
    download_file_content: vi.fn(async (item: OneDriveDeltaItem) => {
      downloaded.push(item.item_id);
      return Buffer.from(item.item_id);
    }),
    list_file_versions: vi.fn().mockResolvedValue([]),
  };

  const context = {
    tenant_id: 't',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    },
    encrypt: (buffer: Buffer) => buffer,
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };

  const service = new OneDriveBackupService(
    factory,
    connector as never,
    { save: vi.fn() } as never,
    { load_version_watermarks: vi.fn().mockResolvedValue({}), write_run_index: vi.fn() } as never,
    {
      load: vi.fn().mockResolvedValue(options.stored_cursor),
      save: vi.fn((_ctx: TenantContext, cursor: OneDriveDeltaCursor) => {
        saved.push(structuredClone(cursor));
        return Promise.resolve();
      }),
    } as never,
  );

  return { service, fetch_delta, saved, downloaded };
}

function make_cursor(overrides: Partial<OneDriveDeltaCursor> = {}): OneDriveDeltaCursor {
  return {
    owner_id: OWNER_ID,
    delta_link_by_drive: { [DRIVE_ID]: 'delta-1' },
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('backup_onedrive with a folder scope', () => {
  const items = [
    make_item('in', '/E2E'),
    make_item('deep', '/E2E/Nested'),
    make_item('out', '/Other'),
  ];

  it('backs up only the scoped subtree and downloads nothing else', async () => {
    const harness = make_harness({ delta_items: items });

    const result = await harness.service.backup_onedrive('t', OWNER_ID, { folder_scope: 'E2E' });

    expect(harness.downloaded.sort()).toEqual(['deep', 'in']);
    expect(result.snapshot?.entries.map((e) => e.file_id).sort()).toEqual(['deep', 'in']);
  });

  it('records the normalised scope in the cursor', async () => {
    const harness = make_harness({ delta_items: items });

    await harness.service.backup_onedrive('t', OWNER_ID, { folder_scope: 'E2E/' });

    expect(harness.saved[0]?.folder_scope).toBe('/E2E');
  });

  it('leaves the scope absent for a whole-drive backup', async () => {
    const harness = make_harness({ delta_items: items });

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.downloaded.sort()).toEqual(['deep', 'in', 'out']);
    expect(harness.saved[0]?.folder_scope).toBeUndefined();
  });

  it('resumes the delta link when the scope is unchanged', async () => {
    const harness = make_harness({
      delta_items: items,
      stored_cursor: make_cursor({ folder_scope: '/E2E' }),
    });

    await harness.service.backup_onedrive('t', OWNER_ID, { folder_scope: '/E2E' });

    expect(harness.fetch_delta).toHaveBeenCalledWith('t', OWNER_ID, DRIVE_ID, 'delta-1');
  });

  it('re-crawls when the scope narrows, instead of resuming a drive-wide link', async () => {
    const harness = make_harness({ delta_items: items, stored_cursor: make_cursor() });

    await harness.service.backup_onedrive('t', OWNER_ID, { folder_scope: '/E2E' });

    expect(harness.fetch_delta).toHaveBeenCalledWith('t', OWNER_ID, DRIVE_ID, undefined);
  });

  it('re-crawls when the scope widens, so filtered-out changes are not lost', async () => {
    const harness = make_harness({
      delta_items: items,
      stored_cursor: make_cursor({ folder_scope: '/E2E' }),
    });

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.fetch_delta).toHaveBeenCalledWith('t', OWNER_ID, DRIVE_ID, undefined);
  });
});
