/**
 * Issue #673: the run's abort signal reached the CDN download paths but not `with_graph_retry`,
 * so Ctrl+C during a delta listing parked in a Graph Retry-After sat the wait out.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  SharePointBackupUseCase,
  SharePointDeltaCursor,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { SharePointBackupService } from '@/services/backup/backup.service';
import { SharePointSiteTreeBackupService } from '@/services/backup/site-tree-backup.service';

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
  site_id: 'site-1',
  delta_link_by_drive: { 'drive-1': 'old-link' },
  previous_path_by_file_id: {},
  previous_name_by_file_id: {},
  previous_etag_by_file_id: {},
  previous_kind_by_file_id: {},
  version_watermark_by_file_id: {},
  updated_at: '2026-01-01T00:00:00.000Z',
} as unknown as SharePointDeltaCursor;

interface Harness {
  service: SharePointBackupService;
  cursor_save: Mock;
}

function make_harness(connector: Record<string, unknown>): Harness {
  const context = {
    storage: {
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    },
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = {
    create: vi.fn().mockResolvedValue(context),
  } as unknown as TenantContextFactory;
  const cursor_save = vi.fn();
  const service = new SharePointBackupService(
    factory,
    connector as never,
    { list_snapshots_by_site: vi.fn().mockResolvedValue([]) } as never,
    { write_run_index: vi.fn() } as never,
    { load: vi.fn().mockResolvedValue(STORED_CURSOR), save: cursor_save } as never,
  );
  return { service, cursor_save };
}

describe('SharePoint backup cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the delta listing wait within a second and records an interrupted run', async () => {
    const { service, cursor_save } = make_harness({
      list_document_libraries: vi
        .fn()
        .mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
      fetch_delta: vi.fn(graph_call_parked_in_retry_wait),
    });
    const controller = new AbortController();
    let settled = false;

    const run = service
      .backup_site('tenant-1', 'site-1', { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.summary.errors).toEqual([]);
    for (const [, cursor] of cursor_save.mock.calls) {
      expect(cursor.delta_link_by_drive).toEqual({ 'drive-1': 'old-link' });
    }
  });

  it('ends a subsite listing wait, which runs before any site is backed up', async () => {
    const backup = { backup_site: vi.fn() } as unknown as SharePointBackupUseCase;
    const tree = new SharePointSiteTreeBackupService(
      { list_subsites: vi.fn(graph_call_parked_in_retry_wait) } as never,
      backup,
    );
    const controller = new AbortController();

    let settled = false;

    const run = tree
      .backup_site_tree('tenant-1', 'site-1', { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const results = await run;
    expect(results.map((result) => result.interrupted)).toEqual([true]);
    expect(backup.backup_site).not.toHaveBeenCalled();
  });
});
