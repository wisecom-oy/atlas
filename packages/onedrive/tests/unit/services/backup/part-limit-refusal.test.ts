import { describe, expect, it, vi } from 'vitest';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
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
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';
import { record_item_outcome_failure } from '@/services/backup/drive-item-outcome';
import type { SingleDriveResult } from '@/services/backup/backup-drive-processor';

// Issue #925: a file too large for the multipart part limit uploaded 78 GiB, failed, and spent one
// of its five attempts per run. It is now refused before any upload and recorded as permanently
// skipped with a reason naming the limit, so it is not retried until it changes.

vi.mock('@/services/backup/backup-file-processor', () => ({ process_backup_file: vi.fn() }));

const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'disk-image.vhdx',
  parent_path: '/Images',
  size_bytes: max_streamed_object_bytes() + 1,
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

function listed_size_refusal(): Error {
  try {
    plan_multipart_part_size(ITEM.size_bytes);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the plan to refuse the item');
}

describe('a file too large for the multipart part limit (issue #925)', () => {
  it('is recorded as permanent with a reason naming the limit, and not retried', async () => {
    const refusal = listed_size_refusal();
    vi.mocked(process_backup_file).mockRejectedValueOnce(refusal);

    const outcome = await process_delta_item(
      {} as never,
      ITEM,
      'owner-1',
      'snap-1',
      {} as never,
      empty_state(),
      { total_versions_stored: 0, total_versions_unavailable: 0, total_versions_failed: 0 },
      () => {},
      { watermarks: {}, pending: {}, rows: new Map() } as never,
    );
    const result = empty_result();
    record_item_outcome_failure(result, new Set(), 'drive-1', ITEM, outcome);

    expect(outcome).toMatchObject({ permanent: true, error: refusal.message });
    expect(refusal.message).toContain('at most 10000 parts per multipart upload');
    expect(retryable_items(result.failed_items, 'drive-1')).toEqual([]);
    expect(describe_failed_items(result.failed_items)[0]).toContain('not retried');
  });
});
