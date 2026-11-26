import { describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import {
  describe_failed_items,
  retryable_items,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  max_streamed_object_bytes,
  plan_multipart_part_size,
} from '@wisecom/atlas-core/services/shared/multipart-part-plan';
import { process_backup_file } from '@/services/backup/backup-file-processor';
import {
  process_delta_item,
  type FileTrackingState,
  type LibraryProcessingState,
} from '@/services/backup/library-item-processor';

// Issue #925, SharePoint twin of the OneDrive test: a file too large for the multipart part limit
// is recorded as permanently skipped with a reason naming the limit, and is not retried.

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'disk-image.vhdx',
  parent_path: '/Shared Documents',
  size_bytes: max_streamed_object_bytes() + 1,
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

function thrown_by(call: () => unknown): unknown {
  try {
    call();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

async function process_failing_with(library: LibraryProcessingState, error: unknown) {
  vi.mocked(process_backup_file).mockRejectedValueOnce(error);
  await process_delta_item(
    {} as never,
    ITEM,
    'site-1',
    'snap-1',
    {} as never,
    empty_tracking(),
    library,
    { watermarks: {}, pending: {}, rows: new Map() } as never,
    { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
  );
}

describe('a file too large for the multipart part limit (issue #925)', () => {
  it('is recorded as permanent with a reason naming the limit, and not retried', async () => {
    const library = empty_library();
    const refusal = thrown_by(() => plan_multipart_part_size(ITEM.size_bytes)) as Error;

    await process_failing_with(library, refusal);

    expect(library.failed_items['item-1']).toMatchObject({
      permanent: true,
      reason: refusal.message,
    });
    expect(refusal.message).toContain('at most 10000 parts per multipart upload');
    expect(retryable_items(library.failed_items, 'drive-1')).toEqual([]);
    expect(describe_failed_items(library.failed_items)[0]).toContain('not retried');
  });
});
