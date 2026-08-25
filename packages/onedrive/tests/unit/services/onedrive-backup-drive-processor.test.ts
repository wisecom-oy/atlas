import { describe, expect, it, vi } from 'vitest';
import type {
  BackupProgressReporter,
  OneDriveConnector,
  OneDriveDeltaCursorRepository,
  OneDriveDrive,
  TenantContext,
} from '@wisecom/atlas-types';
import { process_delta_item } from '@/services/onedrive-delta-item-processor';
import { scan_all_drives } from '@/services/onedrive-backup-drive-processor';
import type { RunVersionCollector } from '@/services/onedrive-version-sync';

const EMPTY_VERSIONS: RunVersionCollector = { known: new Map(), rows: new Map() };
const FILE_INDEXES = {
  load_known_version_ids: vi.fn().mockResolvedValue(new Map()),
};

vi.mock('@/services/onedrive-delta-item-processor', () => ({
  clear_file_tracking_on_reset: vi.fn(),
  process_delta_item: vi.fn(),
}));

const DRIVES: OneDriveDrive[] = [
  { drive_id: 'd1', drive_name: 'Documents' },
  { drive_id: 'd2', drive_name: 'SitePages' },
];

function make_reporter_recorder(): { reporter: BackupProgressReporter; calls: string[] } {
  const calls: string[] = [];
  const reporter: BackupProgressReporter = {
    set_status: () => {},
    mark_active: (i) => calls.push(`active:${i}`),
    update_active: () => {},
    update_paging: (i) => calls.push(`paging:${i}`),
    set_row_total: (i, total) => calls.push(`total:${i}=${total}`),
    mark_done: (i, stored, deduped, versions) =>
      calls.push(`done:${i}=${stored}/${deduped}/${versions}`),
    mark_synced: (i) => calls.push(`synced:${i}`),
    mark_all_pending_interrupted: () => {},
    mark_error: (i, message) => calls.push(`error:${i}=${message}`),
    update_total: () => {},
    finish: () => calls.push('finish'),
  };
  return { reporter, calls };
}

describe('scan_all_drives progress reporting', () => {
  it('reports paging, totals, and per-drive outcomes; errors keep other drives going', async () => {
    const connector = {
      fetch_delta: vi
        .fn()
        .mockResolvedValueOnce({ items: [], delta_link: 'next-1', reset_detected: false })
        .mockRejectedValueOnce(new Error('boom')),
    } as unknown as OneDriveConnector;
    const cursors = { save: vi.fn() } as unknown as OneDriveDeltaCursorRepository;
    const { reporter, calls } = make_reporter_recorder();

    const result = await scan_all_drives(
      connector,
      FILE_INDEXES as never,
      cursors,
      DRIVES,
      'tenant-1',
      'owner-1',
      'od-snap-test',
      {} as TenantContext,
      {
        previous_path_by_file_id: {},
        previous_name_by_file_id: {},
        previous_etag_by_file_id: {},
        previous_kind_by_file_id: {},
      },
      {},
      { delta_link_by_drive: { d1: 'prev-link' } },
      false,
      EMPTY_VERSIONS,
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
      () => {},
      reporter,
    );

    expect(calls).toEqual([
      'paging:0',
      'total:0=0',
      'active:0',
      'synced:0',
      'paging:1',
      'error:1=boom',
    ]);
    expect(result.errors).toHaveLength(1);
    expect(cursors.save).toHaveBeenCalledTimes(1);
  });

  it('stops between items and retains the prior drive delta link', async () => {
    let interrupted = false;
    const items = ['item-1', 'item-2'].map((item_id) => ({
      item_id,
      drive_id: 'd1',
      kind: 'file' as const,
      file_name: `${item_id}.txt`,
      parent_path: '/Documents',
      size_bytes: 1,
      deleted: false,
    }));
    const connector = {
      fetch_delta: vi.fn().mockResolvedValue({
        items,
        delta_link: 'next-link',
        reset_detected: false,
      }),
    } as unknown as OneDriveConnector;
    vi.mocked(process_delta_item).mockResolvedValue({
      files_stored: 1,
      files_deduplicated: 0,
      deleted_items: 0,
    });
    const cursors = { save: vi.fn() } as unknown as OneDriveDeltaCursorRepository;

    const result = await scan_all_drives(
      connector,
      FILE_INDEXES as never,
      cursors,
      [DRIVES[0]!],
      'tenant-1',
      'owner-1',
      'od-snap-test',
      {} as TenantContext,
      {
        previous_path_by_file_id: {},
        previous_name_by_file_id: {},
        previous_etag_by_file_id: {},
        previous_kind_by_file_id: {},
      },
      { d1: 'prev-link' },
      { delta_link_by_drive: { d1: 'prev-link' } },
      false,
      EMPTY_VERSIONS,
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
      () => {},
      undefined,
      {
        should_interrupt: () => interrupted,
        on_progress: () => {
          interrupted = true;
        },
      },
    );

    expect(process_delta_item).toHaveBeenCalledOnce();
    expect(result.interrupted).toBe(true);
    expect(vi.mocked(cursors.save).mock.calls[0]![1].delta_link_by_drive).toEqual({
      d1: 'prev-link',
    });
  });
});
