import { describe, expect, it, vi } from 'vitest';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
  MAX_FAILED_ITEM_ATTEMPTS,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import { DownloadUrlExpiredError } from '@wisecom/atlas-drive/backup/large-file-url-refresh';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import {
  process_delta_item,
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';
import { record_item_outcome_failure } from '@/services/backup/drive-item-outcome';
import type { SingleDriveResult } from '@/services/backup/backup-drive-processor';

// Issue #718: a file skipped because its download URL expired is retried without spending one of
// its five ledger attempts. A refusal and an ordinary failure keep their existing handling.

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'movie.mp4',
  parent_path: '/Videos',
  size_bytes: 1,
  deleted: false,
  etag: 'etag-1',
  last_modified_at: '2026-08-01T00:00:00Z',
} as OneDriveDeltaItem;

function empty_state(): DriveTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
}

function empty_result(): SingleDriveResult {
  return {
    entries: [],
    files_stored: 0,
    files_deduplicated: 0,
    deleted_items: 0,
    failed_items: {},
    errors: [],
    package_report: { notebooks_detected: 0, section_files_backed_up: 0, warnings: [] },
    interrupted: false,
  };
}

/** Runs one item whose download fails with `error`, and returns the outcome it produced. */
async function outcome_for(error: unknown) {
  vi.mocked(process_backup_file).mockRejectedValueOnce(error);
  return process_delta_item(
    {} as never,
    ITEM,
    'owner-1',
    'snap-1',
    {} as never,
    empty_state(),
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
    { watermarks: {}, rows: new Map() } as never,
  );
}

describe('expired download URL and the failed-item ledger (issue #718)', () => {
  it('records an expired-URL skip without spending an attempt, however often it recurs', async () => {
    const result = empty_result();

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS + 2; run++) {
      const outcome = await outcome_for(
        new DownloadUrlExpiredError('URL expired', new Error('403')),
      );
      expect(outcome).toMatchObject({ url_expired: true, error: 'URL expired' });
      record_item_outcome_failure(result, new Set(), 'drive-1', ITEM, outcome);
    }

    expect(result.failed_items['item-1']).toMatchObject({ attempts: 0 });
    expect(retryable_items(result.failed_items, 'drive-1')).toHaveLength(1);
  });

  it('still spends an attempt on an ordinary failure after an expired-URL skip', async () => {
    const result = empty_result();
    const expired = await outcome_for(new DownloadUrlExpiredError('URL expired', new Error('403')));
    record_item_outcome_failure(result, new Set(), 'drive-1', ITEM, expired);

    // An ordinary failure reaches here as an undefined download, which the file processor returns.
    vi.mocked(process_backup_file).mockResolvedValueOnce(undefined);
    const failed = await process_delta_item(
      {} as never,
      ITEM,
      'owner-1',
      'snap-1',
      {} as never,
      empty_state(),
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
      () => {},
      { watermarks: {}, rows: new Map() } as never,
    );
    expect(failed.url_expired).toBeUndefined();
    record_item_outcome_failure(result, new Set(), 'drive-1', ITEM, failed);

    expect(result.failed_items['item-1']).toMatchObject({ attempts: 1 });
  });

  it('keeps a Graph refusal permanent rather than treating it as an expired URL', async () => {
    const outcome = await outcome_for(new DownloadRefusedError('refused', 'notAllowed'));

    expect(outcome).toMatchObject({ permanent: true, error: 'refused' });
    expect(outcome.url_expired).toBeUndefined();
  });
});
