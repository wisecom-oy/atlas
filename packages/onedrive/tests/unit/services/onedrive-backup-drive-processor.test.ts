import { describe, expect, it, vi } from 'vitest';
import type {
  BackupProgressReporter,
  OneDriveConnector,
  OneDriveDeltaCursorRepository,
  OneDriveDrive,
  OneDriveFileVersionIndexRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { scan_all_drives } from '@/services/onedrive-backup-drive-processor';

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
      {} as OneDriveFileVersionIndexRepository,
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
});
