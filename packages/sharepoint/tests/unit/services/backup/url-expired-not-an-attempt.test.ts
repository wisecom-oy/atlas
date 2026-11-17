import { describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import {
  MAX_FAILED_ITEM_ATTEMPTS,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import { DownloadUrlExpiredError } from '@wisecom/atlas-drive/backup/large-file-url-refresh';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import {
  process_delta_item,
  type FileTrackingState,
  type LibraryProcessingState,
} from '@/services/backup/library-item-processor';

// Issue #718, SharePoint twin of the OneDrive test: an expired-URL skip spends no ledger attempt.

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
} as SharePointDeltaItem;

function empty_tracking(): FileTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
  };
}

function empty_library(): LibraryProcessingState {
  return {
    library_entries: [],
    library_name: 'Documents',
    library_files_stored: 0,
    library_files_deduplicated: 0,
    library_deleted_items: 0,
    failed_items: {},
    failed_item_ids: new Set<string>(),
  };
}

/** Processes the item once, with its download failing with `error`. */
async function process_once(library: LibraryProcessingState, error: unknown): Promise<void> {
  vi.mocked(process_backup_file).mockRejectedValueOnce(error);
  await process_item(library);
}

async function process_item(library: LibraryProcessingState): Promise<void> {
  await process_delta_item(
    {} as never,
    ITEM,
    'site-1',
    'snap-1',
    {} as never,
    empty_tracking(),
    library,
    { watermarks: {}, rows: new Map() } as never,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
  );
}

describe('expired download URL and the failed-item ledger (issue #718)', () => {
  it('records an expired-URL skip without spending an attempt, however often it recurs', async () => {
    const library = empty_library();

    for (let run = 0; run < MAX_FAILED_ITEM_ATTEMPTS + 2; run++) {
      await process_once(library, new DownloadUrlExpiredError('URL expired', new Error('403')));
    }

    expect(library.failed_items['item-1']).toMatchObject({
      attempts: 0,
      reason: 'URL expired',
    });
    expect(retryable_items(library.failed_items, 'drive-1')).toHaveLength(1);
  });

  it('still spends an attempt on an ordinary failure', async () => {
    const library = empty_library();

    // An ordinary failure reaches the library as an undefined download.
    vi.mocked(process_backup_file).mockResolvedValueOnce(undefined);
    await process_item(library);

    expect(library.failed_items['item-1']).toMatchObject({ attempts: 1 });
  });

  it('keeps a Graph refusal permanent', async () => {
    const library = empty_library();

    await process_once(library, new DownloadRefusedError('refused', 'notAllowed'));

    expect(library.failed_items['item-1']).toMatchObject({ permanent: true, attempts: 1 });
  });
});
