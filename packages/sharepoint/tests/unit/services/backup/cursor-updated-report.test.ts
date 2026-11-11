/**
 * Issue #693: a site backup cancelled before its scan finished saved no delta cursor, yet reported
 * `cursor_updated: true` because the empty-result builder hard-coded it. The field has to say
 * whether this run saved a cursor, on every path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SharePointBackupUseCase,
  SharePointDeltaItem,
  SharePointDeltaResult,
} from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { SharePointSiteTreeBackupService } from '@/services/backup/site-tree-backup.service';
import {
  make_connector,
  make_cursors,
  make_file_item,
  make_service,
} from './backup-determinism.fixtures';

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

/** A delta page holding the given items. */
function delta_of(items: SharePointDeltaItem[]): () => Promise<SharePointDeltaResult> {
  return () =>
    Promise.resolve({
      drive_id: 'drive-1',
      delta_link: 'https://next',
      items,
      reset_detected: false,
    });
}

describe('SharePoint backup reports whether it saved the delta cursor (issue #693)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports cursor_updated false for a run cancelled before it started', async () => {
    const cursors = make_cursors();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    const result = await make_service({ cursors }).backup_site('tenant-1', 'site-1', {
      abort_signal: controller.signal,
      should_interrupt: () => controller.signal.aborted,
    });

    expect(result.interrupted).toBe(true);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(false);
    expect(cursors.save).not.toHaveBeenCalled();
  });

  it('reports cursor_updated false for a run cancelled during the library listing', async () => {
    vi.useFakeTimers();
    const cursors = make_cursors();
    const connector = make_connector({
      list_document_libraries: vi.fn(graph_call_parked_in_retry_wait),
    });
    const controller = new AbortController();

    const run = make_service({ connector, cursors }).backup_site('tenant-1', 'site-1', {
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await run;

    expect(result.interrupted).toBe(true);
    expect(result.summary.cursor_updated).toBe(false);
    expect(cursors.save).not.toHaveBeenCalled();
  });

  it('reports cursor_updated false when a site tree is cancelled before the root site', async () => {
    vi.useFakeTimers();
    const tree = new SharePointSiteTreeBackupService(
      { list_subsites: vi.fn(graph_call_parked_in_retry_wait) } as never,
      { backup_site: vi.fn() } as unknown as SharePointBackupUseCase,
    );
    const controller = new AbortController();

    const run = tree.backup_site_tree('tenant-1', 'site-1', { abort_signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1_000);
    const results = await run;

    expect(results.map((result) => result.summary.cursor_updated)).toEqual([false]);
  });

  it('reports cursor_updated true for a healthy scan that found no changes', async () => {
    const cursors = make_cursors();

    const result = await make_service({ cursors }).backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(true);
    expect(cursors.save).toHaveBeenCalledTimes(1);
  });

  it('reports cursor_updated true when every changed file failed', async () => {
    const cursors = make_cursors();
    const connector = make_connector({
      fetch_delta: vi.fn(delta_of([make_file_item('poison')])),
      download_file_content: vi.fn(() => Promise.reject(new Error('download failed'))),
    });

    const result = await make_service({ connector, cursors }).backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(true);
    expect(cursors.save).toHaveBeenCalledTimes(1);
  });

  it('reports cursor_updated true for a run interrupted between items, which saves its cursor', async () => {
    const cursors = make_cursors();
    let checks = 0;

    const result = await make_service({ cursors }).backup_site('tenant-1', 'site-1', {
      should_interrupt: () => ++checks > 1,
    });

    expect(result.interrupted).toBe(true);
    expect(result.summary.cursor_updated).toBe(true);
    expect(cursors.save).toHaveBeenCalledTimes(1);
  });
});
