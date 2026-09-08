import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/backup/backup.service';

// Issue #339: change tracking must never be committed ahead of the snapshot
// that makes the scanned content reachable. A manifest write that fails after
// the cursor was saved orphans the ciphertext and the next run sees no work.

const DRIVE_ID = 'd1';
const OWNER_ID = 'owner-1';

function make_item(item_id: string): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: DRIVE_ID,
    kind: 'file',
    file_name: `${item_id}.txt`,
    parent_path: '/',
    size_bytes: 8,
    deleted: false,
    etag: `etag-${item_id}`,
    last_modified_at: '2026-08-01T00:00:00Z',
  };
}

interface Harness {
  service: OneDriveBackupService;
  save_order: string[];
  saved_cursors: OneDriveDeltaCursor[];
}

function make_harness(options: {
  manifest_error?: Error;
  previous_cursor?: OneDriveDeltaCursor | undefined;
  drives?: { drive_id: string; drive_name: string }[];
}): Harness {
  const save_order: string[] = [];
  const saved_cursors: OneDriveDeltaCursor[] = [];
  const drives = options.drives ?? [{ drive_id: DRIVE_ID, drive_name: 'Documents' }];

  const connector = {
    list_drives: vi.fn().mockResolvedValue(drives),
    fetch_delta: vi.fn((_t: string, _o: string, drive_id: string) =>
      Promise.resolve({
        drive_id,
        delta_link: `delta-${drive_id}`,
        items: [make_item(`f-${drive_id}`)],
        reset_detected: false,
      }),
    ),
    fetch_item_by_id: vi.fn(),
    download_file_content: vi.fn((item: OneDriveDeltaItem) =>
      Promise.resolve(Buffer.from(item.item_id)),
    ),
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

  const cursors = {
    load: vi.fn().mockResolvedValue(options.previous_cursor),
    save: vi.fn((_ctx: TenantContext, cursor: OneDriveDeltaCursor) => {
      save_order.push('cursor');
      saved_cursors.push(structuredClone(cursor));
      return Promise.resolve();
    }),
  };
  const manifests = {
    save: vi.fn(() => {
      save_order.push('manifest');
      return options.manifest_error
        ? Promise.reject(options.manifest_error)
        : Promise.resolve(undefined);
    }),
  };

  const service = new OneDriveBackupService(
    factory,
    connector as never,
    manifests as never,
    {
      load_version_watermarks: vi.fn().mockResolvedValue({}),
      write_run_index: vi.fn(),
    } as never,
    cursors as never,
  );
  return { service, save_order, saved_cursors };
}

describe('OneDrive backup cursor and snapshot ordering (issue #339)', () => {
  it('saves the cursor only after the snapshot manifest', async () => {
    const harness = make_harness({});

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.save_order).toEqual(['manifest', 'cursor']);
  });

  it('saves one cursor for the whole run, not one per drive', async () => {
    const harness = make_harness({
      drives: [
        { drive_id: 'd1', drive_name: 'Documents' },
        { drive_id: 'd2', drive_name: 'Pictures' },
      ],
    });

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.save_order).toEqual(['manifest', 'cursor']);
    expect(harness.saved_cursors[0]?.delta_link_by_drive).toEqual({
      d1: 'delta-d1',
      d2: 'delta-d2',
    });
  });

  it('leaves the cursor untouched when the manifest write fails', async () => {
    const harness = make_harness({ manifest_error: new Error('manifest write failed') });

    await expect(harness.service.backup_onedrive('t', OWNER_ID)).rejects.toThrow(
      'manifest write failed',
    );

    expect(harness.saved_cursors).toEqual([]);
  });

  it('recovers the file on the next run after a failed manifest write', async () => {
    const failed = make_harness({ manifest_error: new Error('manifest write failed') });
    await failed.service.backup_onedrive('t', OWNER_ID).catch(() => undefined);

    // The retry loads whatever run 1 committed, which must still be nothing.
    const retry = make_harness({ previous_cursor: failed.saved_cursors.at(-1) });
    const result = await retry.service.backup_onedrive('t', OWNER_ID);

    expect(result.snapshot?.entries.map((entry) => entry.file_id)).toEqual([`f-${DRIVE_ID}`]);
    expect(result.summary.healthy).toBe(true);
  });
});
