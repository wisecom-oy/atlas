/**
 * Issue #693: a OneDrive backup cancelled before its scan finished saved no delta cursor, yet
 * reported `cursor_updated: true` because the empty-result builder hard-coded it. The field has to
 * say whether this run saved a cursor, on every path.
 */

import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { OneDriveBackupService } from '@/services/backup/backup.service';
import { latest_readable, readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

/** A Graph call throttled with `Retry-After: 600`, which on its own waits ten minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '600' }),
    }),
  );
}

const FILE: OneDriveDeltaItem = {
  item_id: 'f1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'a.txt',
  parent_path: '/',
  size_bytes: 8,
  deleted: false,
  etag: 'etag-f1',
};

interface Harness {
  run: (options?: OneDriveBackupOptions) => Promise<OneDriveBackupResult>;
  cursor_save: Mock;
}

/** A backup service over one drive whose connector calls the case can replace. */
function make_harness(connector_overrides: Record<string, unknown> = {}): Harness {
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'OneDrive' }]),
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'drive-1',
      delta_link: 'next-link',
      items: [],
      reset_detected: false,
    }),
    fetch_item_by_id: vi.fn(),
    download_file_content: vi.fn(),
    list_file_versions: vi.fn().mockResolvedValue([]),
    ...connector_overrides,
  };
  const context = {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    },
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = { create: vi.fn().mockResolvedValue(context) } as unknown as TenantContextFactory;
  const cursor_save = vi.fn().mockResolvedValue(undefined);
  const service = new OneDriveBackupService(
    factory,
    connector as never,
    {
      find_latest_readable: vi.fn().mockResolvedValue(latest_readable(undefined)),
      list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
    } as never,
    {
      load_version_watermarks: vi.fn().mockResolvedValue({}),
      write_run_index: vi.fn().mockResolvedValue(undefined),
    } as never,
    { load: vi.fn().mockResolvedValue(undefined), save: cursor_save } as never,
    stub_owner_leases().leases,
  );
  return {
    run: (options = {}) => service.backup_onedrive('tenant-1', 'owner-1', options),
    cursor_save,
  };
}

describe('OneDrive backup reports whether it saved the delta cursor (issue #693)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports cursor_updated false for a run cancelled before it started', async () => {
    const { run, cursor_save } = make_harness();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const result = await run({
      abort_signal: controller.signal,
      should_interrupt: () => controller.signal.aborted,
    });

    expect(result.interrupted).toBe(true);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(false);
    expect(cursor_save).not.toHaveBeenCalled();
  });

  it('reports cursor_updated false for a run cancelled during the drive listing', async () => {
    vi.useFakeTimers();
    const { run, cursor_save } = make_harness({
      list_drives: vi.fn(graph_call_parked_in_retry_wait),
    });
    const controller = new AbortController();

    const pending = run({ abort_signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.interrupted).toBe(true);
    expect(result.summary.cursor_updated).toBe(false);
    expect(cursor_save).not.toHaveBeenCalled();
  });

  it('reports cursor_updated true for a healthy scan that found no changes', async () => {
    const { run, cursor_save } = make_harness();

    const result = await run();

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(true);
    expect(cursor_save).toHaveBeenCalledTimes(1);
  });

  it('reports cursor_updated true when every changed file failed', async () => {
    const { run, cursor_save } = make_harness({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'next-link',
        items: [FILE],
        reset_detected: false,
      }),
      download_file_content: vi.fn().mockRejectedValue(new Error('download failed')),
    });

    const result = await run();

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(true);
    expect(cursor_save).toHaveBeenCalledTimes(1);
  });

  it('reports cursor_updated true for a run interrupted between items, which saves its cursor', async () => {
    const { run, cursor_save } = make_harness();
    let checks = 0;

    const result = await run({ should_interrupt: () => ++checks > 1 });

    expect(result.interrupted).toBe(true);
    expect(result.summary.cursor_updated).toBe(true);
    expect(cursor_save).toHaveBeenCalledTimes(1);
  });
});
