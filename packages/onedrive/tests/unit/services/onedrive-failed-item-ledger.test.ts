import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  OneDriveConnector,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { MAX_FAILED_ITEM_ATTEMPTS } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { OneDriveBackupService } from '@/services/onedrive-backup.service';
import { resolve_retry_items } from '@/services/onedrive-failed-item-retry';

// Issue #34: one persistently failing file must not freeze a drive's delta
// cursor. The run keeps its successful entries, advances the delta link, and
// records the failure so the next run retries it instead of losing it.

const DRIVE_ID = 'd1';
const OWNER_ID = 'owner-1';

function make_item(item_id: string, file_name: string): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: DRIVE_ID,
    kind: 'file',
    file_name,
    parent_path: '/',
    size_bytes: 8,
    deleted: false,
    etag: `etag-${item_id}`,
    last_modified_at: '2026-08-01T00:00:00Z',
  };
}

function make_cursor(failed_items: OneDriveDeltaCursor['failed_items']): OneDriveDeltaCursor {
  return {
    owner_id: OWNER_ID,
    delta_link_by_drive: { [DRIVE_ID]: 'delta-1' },
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    failed_items,
    updated_at: '2026-08-01T00:00:00Z',
  };
}

function make_failure(
  item_id: string,
  attempts: number,
): NonNullable<OneDriveDeltaCursor['failed_items']>[string] {
  return {
    item_id,
    drive_id: DRIVE_ID,
    name: `${item_id}.txt`,
    reason: 'Failed to process file',
    attempts,
    first_failed_at: '2026-07-01T00:00:00Z',
    last_failed_at: '2026-07-02T00:00:00Z',
  };
}

interface Harness {
  service: OneDriveBackupService;
  fetch_item_by_id: Mock;
  saved_cursors: OneDriveDeltaCursor[];
  calls: string[];
  /** `cursor` / `manifest` in the order they were persisted. */
  save_order: string[];
}

function make_harness(options: {
  delta_items: OneDriveDeltaItem[];
  delta_link: string;
  poison_ids?: string[];
  previous_cursor?: OneDriveDeltaCursor;
  retry_item?: OneDriveDeltaItem;
}): Harness {
  const poison = new Set(options.poison_ids ?? []);
  const calls: string[] = [];
  const saved_cursors: OneDriveDeltaCursor[] = [];
  const save_order: string[] = [];

  const fetch_item_by_id = vi.fn(async (..._args: string[]) => {
    calls.push(`fetch:${_args[3]}`);
    return options.retry_item;
  });

  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: DRIVE_ID, drive_name: 'Documents' }]),
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: DRIVE_ID,
      delta_link: options.delta_link,
      items: options.delta_items,
      reset_detected: false,
    }),
    fetch_item_by_id,
    download_file_content: vi.fn(async (item: OneDriveDeltaItem) => {
      calls.push(`download:${item.item_id}`);
      if (poison.has(item.item_id)) throw new Error(`poison ${item.item_id}`);
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
  const manifests = { save: vi.fn(() => void save_order.push('manifest')) };

  const service = new OneDriveBackupService(
    factory,
    connector as never,
    manifests as never,
    { append_version: vi.fn() } as never,
    cursors as never,
  );
  return { service, fetch_item_by_id, saved_cursors, calls, save_order };
}

/** The cursor written by the drive scan itself -- the save that must happen even on failure. */
function drive_cursor(harness: Harness): OneDriveDeltaCursor {
  const cursor = harness.saved_cursors[0];
  if (!cursor) throw new Error('the drive scan saved no cursor');
  return cursor;
}

describe('OneDrive persistent item failure (issue #34)', () => {
  it('keeps healthy files and advances the delta link past a poison file', async () => {
    const harness = make_harness({
      delta_items: [
        make_item('ok1', 'a.txt'),
        make_item('p1', 'poison.txt'),
        make_item('ok2', 'b.txt'),
      ],
      delta_link: 'delta-2',
      poison_ids: ['p1'],
    });

    const result = await harness.service.backup_onedrive('t', OWNER_ID);

    expect(result.snapshot?.entries.map((entry) => entry.file_id)).toEqual(['ok1', 'ok2']);
    expect(result.summary.files_stored).toBe(2);
    expect(drive_cursor(harness).delta_link_by_drive[DRIVE_ID]).toBe('delta-2');
    expect(harness.fetch_item_by_id).not.toHaveBeenCalled();
  });

  it('records the failed item in the saved cursor and reports the run unhealthy', async () => {
    const harness = make_harness({
      delta_items: [make_item('ok1', 'a.txt'), make_item('p1', 'poison.txt')],
      delta_link: 'delta-2',
      poison_ids: ['p1'],
    });

    const result = await harness.service.backup_onedrive('t', OWNER_ID);

    const saved = drive_cursor(harness);
    expect(saved.delta_link_by_drive[DRIVE_ID]).toBe('delta-2');
    const recorded = saved.failed_items?.p1;
    expect(recorded).toMatchObject({ item_id: 'p1', drive_id: DRIVE_ID, attempts: 1 });
    // The drive checkpoints before the snapshot is written -- the failure must
    // not gate that save, or a later drive crashing loses this drive's progress.
    expect(harness.save_order).toEqual(['cursor', 'manifest', 'cursor']);
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.warnings).toEqual([
      expect.stringContaining('Not backed up: poison.txt (p1)'),
    ]);
    expect(result.summary.warnings[0]).toContain(
      `will retry (attempt 1 of ${MAX_FAILED_ITEM_ATTEMPTS})`,
    );
  });

  it('re-fetches a recorded failure before new delta items and clears it on success', async () => {
    const retried = make_item('p1', 'poison.txt');
    const harness = make_harness({
      delta_items: [make_item('n2', 'new.txt')],
      delta_link: 'delta-3',
      previous_cursor: make_cursor({ p1: make_failure('p1', 1) }),
      retry_item: retried,
    });

    const result = await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.fetch_item_by_id).toHaveBeenCalledWith('t', OWNER_ID, DRIVE_ID, 'p1');
    expect(harness.calls).toEqual(['fetch:p1', 'download:p1', 'download:n2']);
    expect(drive_cursor(harness).failed_items).toEqual({});
    expect(result.summary.healthy).toBe(true);
    expect(result.snapshot?.entries.map((entry) => entry.file_id)).toEqual(['p1', 'n2']);
  });

  it('increments the attempt count when the retried item fails again', async () => {
    const harness = make_harness({
      delta_items: [],
      delta_link: 'delta-3',
      poison_ids: ['p1'],
      previous_cursor: make_cursor({ p1: make_failure('p1', 2) }),
      retry_item: make_item('p1', 'poison.txt'),
    });

    await harness.service.backup_onedrive('t', OWNER_ID);

    expect(drive_cursor(harness).failed_items?.p1).toMatchObject({
      attempts: 3,
      first_failed_at: '2026-07-01T00:00:00Z',
    });
  });

  it('clears the record without an error when the item no longer exists', async () => {
    const harness = make_harness({
      delta_items: [],
      delta_link: 'delta-3',
      previous_cursor: make_cursor({ p1: make_failure('p1', 2) }),
    });

    const result = await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.fetch_item_by_id).toHaveBeenCalledTimes(1);
    expect(drive_cursor(harness).failed_items).toEqual({});
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.warnings).toEqual([]);
    expect(result.summary.healthy).toBe(true);
  });

  it('stops re-fetching an item past its attempt budget but keeps reporting it', async () => {
    const harness = make_harness({
      delta_items: [],
      delta_link: 'delta-3',
      previous_cursor: make_cursor({ p1: make_failure('p1', MAX_FAILED_ITEM_ATTEMPTS) }),
    });

    const result = await harness.service.backup_onedrive('t', OWNER_ID);

    expect(harness.fetch_item_by_id).not.toHaveBeenCalled();
    expect(drive_cursor(harness).failed_items?.p1?.attempts).toBe(MAX_FAILED_ITEM_ATTEMPTS);
    expect(result.summary.warnings).toEqual([
      expect.stringContaining(`PERMANENTLY SKIPPED after ${MAX_FAILED_ITEM_ATTEMPTS} attempts`),
    ]);
    expect(result.summary.healthy).toBe(false);
  });
  it('does not fetch another failed item after cancellation', async () => {
    const fetch_item_by_id = vi.fn();
    const connector = { fetch_item_by_id } as unknown as OneDriveConnector;

    const result = await resolve_retry_items(
      connector,
      't',
      OWNER_ID,
      DRIVE_ID,
      { p1: make_failure('p1', 1) },
      new Set<string>(),
      () => true,
    );

    expect(result.interrupted).toBe(true);
    expect(fetch_item_by_id).not.toHaveBeenCalled();
  });
});
