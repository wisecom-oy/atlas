import { describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import type {
  SharePointDeltaItem,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
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
  type LibraryProcessingState,
} from '@/services/backup/library-item-processor';
import { retry_failed_items } from '@/services/backup/library-item-retry';

// Issue #857, SharePoint twin of the OneDrive test: an outage, throttling or a dropped connection
// spends none of the file's five attempts, on the download and on the re-read of a listed file.

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'report.docx',
  parent_path: '/Shared Documents',
  size_bytes: 1,
  deleted: false,
  etag: 'etag-1',
  last_modified_at: '2026-08-01T00:00:00Z',
} as SharePointDeltaItem;

const outage = (): GraphUnavailableError =>
  new GraphUnavailableError('Graph kept failing', { retries: 12, elapsed_ms: 1 });

function library_with(failed_items: FailedItemLedger = {}): LibraryProcessingState {
  return {
    library_entries: [],
    library_name: 'Documents',
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items,
    failed_item_ids: new Set<string>(),
  };
}

/** One run of the item, its download settling as `download` says. */
async function run_once(
  library: LibraryProcessingState,
  download: () => Promise<Awaited<ReturnType<typeof process_backup_file>>>,
): Promise<void> {
  vi.mocked(process_backup_file).mockImplementationOnce(download);
  await process_delta_item(
    {} as never,
    ITEM,
    'site-1',
    'snap-1',
    {} as never,
    {
      previous_path_by_file_id: {},
      previous_name_by_file_id: {},
      previous_etag_by_file_id: {},
      previous_kind_by_file_id: {},
    },
    library,
    { watermarks: {}, pending: {}, rows: new Map() } as never,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
  );
}

const transient_failure = (): Promise<never> =>
  Promise.reject(new TransientDownloadError('Download of report.docx failed', outage()));

describe('SharePoint download failures during an outage (issue #857)', () => {
  it('keeps the file retryable through more outage runs than it has attempts', async () => {
    const library = library_with();

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS + 2; run++) {
      await run_once(library, transient_failure);
    }

    expect(library.failed_items['item-1']).toMatchObject({ attempts: 0 });
    expect(retryable_items(library.failed_items, 'drive-1')).toHaveLength(1);
  });

  it('still skips a file for good after five failures of its own', async () => {
    const library = library_with();
    await run_once(library, transient_failure);

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS; run++) {
      await run_once(library, () => Promise.resolve(undefined));
    }

    expect(library.failed_items['item-1']).toMatchObject({ attempts: MAX_FAILED_ITEM_ATTEMPTS });
    expect(describe_failed_items(library.failed_items)[0]).toContain(
      `PERMANENTLY SKIPPED after ${MAX_FAILED_ITEM_ATTEMPTS} attempts`,
    );
  });
});

describe('SharePoint re-read of a listed file during an outage (issue #857)', () => {
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
    const library = library_with(ledger);
    await reread_into(library, err);
    return library.failed_items;
  }

  function reread_into(library: LibraryProcessingState, err: unknown): Promise<unknown> {
    const connector = {
      fetch_item_by_id: vi.fn().mockRejectedValue(err),
    } as unknown as SharePointSiteConnector;
    return retry_failed_items(
      connector,
      'tenant-1',
      'site-1',
      'snap-1',
      'drive-1',
      {} as TenantContext,
      { previous_path_by_file_id: {}, previous_etag_by_file_id: {} } as never,
      library,
      { watermarks: {}, pending: {}, rows: new Map() } as never,
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
    );
  }

  it('does not spend an attempt on a connection reset', async () => {
    const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET' });

    const ledger = await reread_failing_with(reset, ledger_with_attempts(4));

    expect(ledger['item-1']).toMatchObject({ attempts: 4 });
    expect(ledger['item-1']?.reason).toContain('Retry fetch failed');
    expect(retryable_items(ledger, 'drive-1')).toHaveLength(1);
  });

  // An exhausted budget is a Graph outage: it fails the library instead of touching the ledger, so
  // the item keeps its attempts and stays listed for the next run (issue #881).
  it.each([
    ['an exhausted Graph retry', outage()],
    ['an exhausted throttle', new ThrottledError('throttled', 1_000)],
  ])('fails the library on %s and leaves the attempts as they were', async (_label, err) => {
    const library = library_with(ledger_with_attempts(4));

    await expect(reread_into(library, err)).rejects.toBe(err);

    expect(library.failed_items['item-1']).toMatchObject({ attempts: 4 });
    expect(retryable_items(library.failed_items, 'drive-1')).toHaveLength(1);
  });

  it('spends an attempt on a Graph 400, which belongs to the request for this file', async () => {
    const bad_request = Object.assign(new Error('bad'), {
      statusCode: 400,
      code: 'invalidRequest',
    });

    const ledger = await reread_failing_with(bad_request, ledger_with_attempts(4));

    expect(ledger['item-1']).toMatchObject({ attempts: 5 });
    expect(retryable_items(ledger, 'drive-1')).toHaveLength(0);
  });
});
