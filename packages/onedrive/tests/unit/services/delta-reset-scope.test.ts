import { describe, expect, it } from 'vitest';
import {
  clear_file_tracking_on_reset,
  type DriveTrackingState,
} from '@/services/backup/delta-item-processor';
import { classify_change_type } from '@/services/backup/change-classifier';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';

/**
 * Issue #199 was filed against SharePoint, but this file had the identical
 * defect: tracking keyed by file id alone, shared across every drive an owner
 * has, wiped wholesale on any one drive's reset.
 *
 * OneDrive has a second way to hit it. With `--folder` the delta is scoped
 * before it reaches here, so an unscoped clear also forgot files the run never
 * looked at.
 */
function make_tracking(): DriveTrackingState {
  return {
    previous_path_by_file_id: { a1: '/Projects', b1: '/Archive' },
    previous_name_by_file_id: { a1: 'a.docx', b1: 'b.docx' },
    previous_etag_by_file_id: { a1: 'ea', b1: 'eb' },
    previous_kind_by_file_id: { a1: 'file', b1: 'file' },
  };
}

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'b1',
    drive_id: 'drive-b',
    file_name: 'b.docx',
    parent_path: '/Archive',
    kind: 'file',
    size_bytes: 10,
    etag: 'eb2',
    deleted: false,
    ...overrides,
  } as OneDriveDeltaItem;
}

describe('clear_file_tracking_on_reset', () => {
  it('leaves a sibling drive untouched when another drive resets', () => {
    const tracking = make_tracking();

    clear_file_tracking_on_reset(tracking, ['a1']);

    expect(tracking.previous_path_by_file_id.b1).toBe('/Archive');
    expect(tracking.previous_etag_by_file_id.b1).toBe('eb');
  });

  it('classifies a sibling edit as updated, not created, after another reset', () => {
    const tracking = make_tracking();
    clear_file_tracking_on_reset(tracking, ['a1']);

    const change = classify_change_type(
      make_item({ etag: 'eb2' }),
      tracking.previous_path_by_file_id,
      tracking.previous_name_by_file_id,
      tracking.previous_etag_by_file_id,
    );

    expect(change).toBe('updated');
  });

  it('rebaselines the resetting drive so its own files read created', () => {
    const tracking = make_tracking();
    clear_file_tracking_on_reset(tracking, ['a1']);

    const change = classify_change_type(
      make_item({
        item_id: 'a1',
        drive_id: 'drive-a',
        file_name: 'a.docx',
        parent_path: '/Projects',
      }),
      tracking.previous_path_by_file_id,
      tracking.previous_name_by_file_id,
      tracking.previous_etag_by_file_id,
    );

    expect(change).toBe('created');
  });

  it('keeps files outside a folder scope tracked through a reset', () => {
    // The delta reaching the processor is already scoped, so an out-of-scope
    // file is simply absent from it and must survive.
    const tracking = make_tracking();

    clear_file_tracking_on_reset(tracking, ['a1']);

    expect(tracking.previous_path_by_file_id.b1).toBe('/Archive');
  });
});
