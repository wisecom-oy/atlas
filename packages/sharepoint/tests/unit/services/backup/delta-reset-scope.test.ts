import { describe, expect, it } from 'vitest';
import { clear_file_tracking_on_reset } from '@/services/backup/backup-library-processor';
import type { FileTrackingState } from '@/services/backup/library-item-processor';
import { classify_change_type } from '@/services/backup/change-classifier';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';

/**
 * Issue #199: tracking maps are keyed by file id alone and shared by every
 * library in a site scan, so clearing all of them on a reset let one library's
 * dead delta link wipe its siblings' records. A genuine change in a sibling on a
 * still-valid link then classified as `created`, and the manifest carried the
 * wrong change type until that file happened to change again.
 *
 * The scenario mirrors the one in the issue: library L1 resets, library L2 keeps
 * a valid link and has one genuinely edited file.
 */
function make_tracking(): FileTrackingState {
  return {
    // f1 lives in L1, f2 lives in L2. Nothing in the shape records that, which
    // is the whole problem.
    previous_path_by_file_id: { f1: '/L1', f2: '/L2' },
    previous_name_by_file_id: { f1: 'f1.docx', f2: 'f2.docx' },
    previous_etag_by_file_id: { f1: 'e1', f2: 'e2' },
    previous_kind_by_file_id: { f1: 'file', f2: 'file' },
  };
}

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id: 'f2',
    drive_id: 'L2',
    file_name: 'f2.docx',
    parent_path: '/L2',
    kind: 'file',
    size_bytes: 10,
    etag: 'e2b',
    deleted: false,
    ...overrides,
  } as SharePointDeltaItem;
}

describe('clear_file_tracking_on_reset', () => {
  it('leaves a sibling library untouched when another library resets', () => {
    const tracking = make_tracking();

    // L1's reset delta is a full enumeration of L1, so it carries f1 and not f2.
    clear_file_tracking_on_reset(tracking, ['f1']);

    expect(tracking.previous_path_by_file_id.f2).toBe('/L2');
    expect(tracking.previous_name_by_file_id.f2).toBe('f2.docx');
    expect(tracking.previous_etag_by_file_id.f2).toBe('e2');
  });

  it('classifies a sibling edit as updated, not created, after another reset', () => {
    const tracking = make_tracking();
    clear_file_tracking_on_reset(tracking, ['f1']);

    const change = classify_change_type(
      make_item({ etag: 'e2b' }),
      tracking.previous_path_by_file_id,
      tracking.previous_name_by_file_id,
      tracking.previous_etag_by_file_id,
    );

    expect(change).toBe('updated');
  });

  it('rebaselines the resetting library so its own files read created', () => {
    const tracking = make_tracking();
    clear_file_tracking_on_reset(tracking, ['f1']);

    const change = classify_change_type(
      make_item({ item_id: 'f1', drive_id: 'L1', file_name: 'f1.docx', parent_path: '/L1' }),
      tracking.previous_path_by_file_id,
      tracking.previous_name_by_file_id,
      tracking.previous_etag_by_file_id,
    );

    expect(change).toBe('created');
  });

  it('keeps the deleted-item name fallback working for a sibling library', () => {
    // Issue #139 reads the name from tracking when Graph omits it on a tombstone.
    const tracking = make_tracking();
    clear_file_tracking_on_reset(tracking, ['f1']);

    expect(tracking.previous_name_by_file_id.f2).toBe('f2.docx');
  });

  it('does not forget folder entries, only files', () => {
    const tracking = make_tracking();
    tracking.previous_kind_by_file_id.d1 = 'folder';
    tracking.previous_path_by_file_id.d1 = '/L1/sub';

    clear_file_tracking_on_reset(tracking, ['f1', 'd1']);

    expect(tracking.previous_path_by_file_id.d1).toBe('/L1/sub');
    expect(tracking.previous_path_by_file_id.f1).toBeUndefined();
  });

  it('ignores ids it has never tracked', () => {
    const tracking = make_tracking();

    expect(() => clear_file_tracking_on_reset(tracking, ['unknown'])).not.toThrow();
    expect(tracking.previous_path_by_file_id.f1).toBe('/L1');
    expect(tracking.previous_path_by_file_id.f2).toBe('/L2');
  });
});
