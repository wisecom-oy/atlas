import { describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import type { OneDriveConnector, OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
  describe_failed_items,
  MAX_FAILED_ITEM_ATTEMPTS,
  record_item_failure,
  retryable_items,
  type FailedItemLedger,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { TransientDownloadError } from '@wisecom/atlas-drive/backup/transient-download-failure';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import {
  process_delta_item,
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';
import { record_item_outcome_failure } from '@/services/backup/drive-item-outcome';
import { resolve_retry_items } from '@/services/backup/failed-item-retry';
import type { SingleDriveResult } from '@/services/backup/backup-drive-processor';

// Issue #857: a download or a re-read that fails because Microsoft 365 is down, throttling, or the
// connection dropped must not spend one of the file's five attempts. Five scheduled runs inside one
// incident otherwise leave the file permanently skipped. The file's own failures still count.

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'report.docx',
  parent_path: '/Documents',
  size_bytes: 1,
  deleted: false,
  etag: 'etag-1',
  last_modified_at: '2026-08-01T00:00:00Z',
} as OneDriveDeltaItem;

const outage = (): GraphUnavailableError =>
  new GraphUnavailableError('Graph kept failing', { retries: 12, elapsed_ms: 1 });

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

/** One run of the item, its download settling as `download` says, recorded into `result`. */
async function run_once(
  result: SingleDriveResult,
  download: () => Promise<Awaited<ReturnType<typeof process_backup_file>>>,
): Promise<void> {
  vi.mocked(process_backup_file).mockImplementationOnce(download);
  const tracking: DriveTrackingState = {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
  const outcome = await process_delta_item(
    {} as never,
    ITEM,
    'owner-1',
    'snap-1',
    {} as never,
    tracking,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    () => {},
    { watermarks: {}, rows: new Map() } as never,
  );
  record_item_outcome_failure(result, new Set(), 'drive-1', ITEM, outcome);
}

const transient_failure = (): Promise<never> =>
  Promise.reject(new TransientDownloadError('Download of report.docx failed', outage()));

describe('OneDrive download failures during an outage (issue #857)', () => {
  it('keeps the file retryable through more outage runs than it has attempts', async () => {
    const result = empty_result();

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS + 2; run++) {
      await run_once(result, transient_failure);
    }

    expect(result.failed_items['item-1']).toMatchObject({ attempts: 0 });
    expect(retryable_items(result.failed_items, 'drive-1')).toHaveLength(1);
    expect(describe_failed_items(result.failed_items)[0]).not.toContain('PERMANENTLY SKIPPED');
  });

  it('still skips a file for good after five failures of its own', async () => {
    const result = empty_result();
    await run_once(result, transient_failure);

    // A failure that belongs to the file reaches here as an undefined download.
    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS; run++) {
      await run_once(result, () => Promise.resolve(undefined));
    }

    expect(result.failed_items['item-1']).toMatchObject({ attempts: MAX_FAILED_ITEM_ATTEMPTS });
    expect(retryable_items(result.failed_items, 'drive-1')).toHaveLength(0);
    expect(describe_failed_items(result.failed_items)[0]).toContain(
      `PERMANENTLY SKIPPED after ${MAX_FAILED_ITEM_ATTEMPTS} attempts`,
    );
  });
});

describe('OneDrive re-read of a listed file during an outage (issue #857)', () => {
  /** A ledger holding the item after `attempts` failures of its own. */
  function ledger_with_attempts(attempts: number): FailedItemLedger {
    let ledger: FailedItemLedger = {};
    for (let i = 0; i < attempts; i++) {
      ledger = record_item_failure(ledger, {
        item_id: 'item-1',
        drive_id: 'drive-1',
        name: 'report.docx',
        reason: 'size mismatch',
      });
    }
    return ledger;
  }

  async function reread_failing_with(err: unknown, ledger: FailedItemLedger) {
    const connector = {
      fetch_item_by_id: vi.fn().mockRejectedValue(err),
    } as unknown as OneDriveConnector;
    return resolve_retry_items(connector, 'tenant-1', 'owner-1', 'drive-1', ledger, new Set());
  }

  it('does not spend an attempt on a connection reset', async () => {
    const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' });

    const resolution = await reread_failing_with(reset, ledger_with_attempts(4));

    expect(resolution.ledger['item-1']).toMatchObject({ attempts: 4 });
    expect(resolution.ledger['item-1']?.reason).toContain('Retry fetch failed');
    expect(retryable_items(resolution.ledger, 'drive-1')).toHaveLength(1);
  });

  // An exhausted budget is a Graph outage: it fails the drive instead of touching the ledger, so
  // the item keeps its attempts and stays listed for the next run (issue #881).
  it.each([
    ['an exhausted Graph retry', outage()],
    ['an exhausted throttle', new ThrottledError('throttled', 1_000)],
  ])('fails the drive on %s and leaves the attempts as they were', async (_label, err) => {
    const ledger = ledger_with_attempts(4);

    await expect(reread_failing_with(err, ledger)).rejects.toBe(err);

    expect(ledger['item-1']).toMatchObject({ attempts: 4 });
    expect(retryable_items(ledger, 'drive-1')).toHaveLength(1);
  });

  it('spends an attempt on a Graph 400, which belongs to the request for this file', async () => {
    const bad_request = Object.assign(new Error('bad'), {
      statusCode: 400,
      code: 'invalidRequest',
    });

    const resolution = await reread_failing_with(bad_request, ledger_with_attempts(4));

    expect(resolution.ledger['item-1']).toMatchObject({ attempts: 5 });
    expect(retryable_items(resolution.ledger, 'drive-1')).toHaveLength(0);
  });
});
