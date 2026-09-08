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
  index_error?: Error;
  previous_cursor?: OneDriveDeltaCursor | undefined;
  drives?: { drive_id: string; drive_name: string }[];
}): Harness {
  const save_order: string[] = [];
  const saved_cursors: OneDriveDeltaCursor[] = [];
  const drives = options.drives ?? [{ drive_id: DRIVE_ID, drive_name: 'Documents' }];

  const connector = {
    list_drives: vi.fn().mockResolvedValue(drives),
    // Cursor-sensitive on purpose: a link this run already advanced past returns nothing, which is
    // what Graph does. A run resuming an advanced link therefore cannot see the missed file.
    fetch_delta: vi.fn((_t: string, _o: string, drive_id: string, prev_delta?: string) =>
      Promise.resolve({
        drive_id,
        delta_link: `delta-${drive_id}`,
        items: prev_delta === `delta-${drive_id}` ? [] : [make_item(`f-${drive_id}`)],
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
      write_run_index: vi.fn(() => {
        save_order.push('index');
        return options.index_error ? Promise.reject(options.index_error) : Promise.resolve();
      }),
    } as never,
    cursors as never,
  );
  return { service, save_order, saved_cursors };
}

describe('OneDrive backup cursor and snapshot ordering (issue #339)', () => {
  it('saves the cursor last, after the manifest and the run version index', async () => {
    const harness = make_harness({});

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.save_order).toEqual(['manifest', 'index', 'cursor']);
  });

  it('saves one cursor for the whole run, not one per drive', async () => {
    const harness = make_harness({
      drives: [
        { drive_id: 'd1', drive_name: 'Documents' },
        { drive_id: 'd2', drive_name: 'Pictures' },
      ],
    });

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.save_order).toEqual(['manifest', 'index', 'cursor']);
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

  it('leaves the cursor untouched when the version index write fails', async () => {
    // The index carries the version rows the cursor's watermarks tell the next run to skip, so a
    // cursor written past a failed index write makes that history unreachable.
    const harness = make_harness({ index_error: new Error('index write failed') });

    await expect(harness.service.backup_onedrive('t', OWNER_ID)).rejects.toThrow(
      'index write failed',
    );

    expect(harness.saved_cursors).toEqual([]);
  });

  it('recovers the file on the next run after a failed manifest write', async () => {
    const failed = make_harness({ manifest_error: new Error('manifest write failed') });
    await failed.service.backup_onedrive('t', OWNER_ID).catch(() => undefined);

    // Run 1 committed nothing, so run 2 resumes the link it started from and Graph presents the
    // change again. Had the cursor advanced, the delta mock would answer with no items and this
    // run would report a healthy empty backup, which is the bug.
    expect(failed.saved_cursors).toEqual([]);
    const retry = make_harness({ previous_cursor: failed.saved_cursors.at(-1) });
    const result = await retry.service.backup_onedrive('t', OWNER_ID);

    expect(result.snapshot?.entries.map((entry) => entry.file_id)).toEqual([`f-${DRIVE_ID}`]);
    expect(result.summary.healthy).toBe(true);
  });

  it('reports the healthy empty run the bug produced when the cursor did advance', async () => {
    // The counterfactual, pinned so the regression above cannot silently stop discriminating: a
    // run resuming an already-advanced link sees nothing and calls that success.
    const advanced = make_harness({
      previous_cursor: {
        owner_id: OWNER_ID,
        delta_link_by_drive: { [DRIVE_ID]: `delta-${DRIVE_ID}` },
        previous_path_by_file_id: {},
        previous_name_by_file_id: {},
        previous_etag_by_file_id: {},
        previous_kind_by_file_id: {},
        updated_at: '2026-08-01T00:00:00Z',
      },
    });

    const result = await advanced.service.backup_onedrive('t', OWNER_ID);

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
  });
});
