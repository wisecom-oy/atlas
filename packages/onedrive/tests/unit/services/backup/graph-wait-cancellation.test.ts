/**
 * Issue #673: the run's abort signal reached the CDN download paths but not `with_graph_retry`,
 * so Ctrl+C during a delta listing parked in a Graph Retry-After sat the wait out.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  OneDriveDeltaCursor,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { OneDriveBackupService } from '@/services/backup/backup.service';
import { latest_readable, readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

/** A Graph call throttled with `Retry-After: 360`, which on its own waits six minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '360' }),
    }),
  );
}

const STORED_CURSOR = {
  owner_id: 'owner-1',
  delta_link_by_drive: { 'drive-1': 'old-link' },
  previous_path_by_file_id: {},
  previous_name_by_file_id: {},
  previous_etag_by_file_id: {},
  previous_kind_by_file_id: {},
  version_watermark_by_file_id: {},
  updated_at: '2026-01-01T00:00:00.000Z',
  // Saved while the owner had no snapshot, and none is stored, so the run resumes it (#725).
  snapshot_id: null,
} as OneDriveDeltaCursor;

interface Harness {
  service: OneDriveBackupService;
  cursor_save: Mock;
}

function make_harness(connector: Record<string, unknown>): Harness {
  const context = {
    storage: {
      list: vi.fn(async () => []),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    },
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = {
    create: vi.fn().mockResolvedValue(context),
  } as unknown as TenantContextFactory;
  const cursor_save = vi.fn();
  const service = new OneDriveBackupService(
    factory,
    connector as never,
    {
      list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
      find_latest_readable: async () => latest_readable(),
    } as never,
    { write_run_index: vi.fn() } as never,
    { load: vi.fn().mockResolvedValue(STORED_CURSOR), save: cursor_save } as never,
    stub_owner_leases().leases,
  );
  return { service, cursor_save };
}

describe('OneDrive backup cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the delta listing wait within a second and records an interrupted run', async () => {
    const { service, cursor_save } = make_harness({
      list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'OneDrive' }]),
      fetch_delta: vi.fn(graph_call_parked_in_retry_wait),
    });
    const controller = new AbortController();
    let settled = false;

    const run = service
      .backup_onedrive('tenant-1', 'owner-1', { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect(cursor_save.mock.calls[0]?.[1].delta_link_by_drive).toEqual({ 'drive-1': 'old-link' });
  });

  it('resolves as interrupted when the drive listing itself is cut short', async () => {
    const { service, cursor_save } = make_harness({
      list_drives: vi.fn(graph_call_parked_in_retry_wait),
    });
    const controller = new AbortController();
    const on_progress = vi.fn();
    let settled = false;

    const run = service
      .backup_onedrive('tenant-1', 'owner-1', { abort_signal: controller.signal, on_progress })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.snapshot).toBeUndefined();
    expect(cursor_save).not.toHaveBeenCalled();
    expect(on_progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'interrupted' }));
  });
});
