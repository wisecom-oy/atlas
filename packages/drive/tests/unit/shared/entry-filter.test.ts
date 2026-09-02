/**
 * `--file-filter` by item ID never matched: the filter was lowercased and Graph
 * drive item IDs carry uppercase (`01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3`).
 * SharePoint restore was fixed in #75; restore and save on both workloads
 * carried the same defect. Live proof: the same save command returned 0 files
 * before and 1 after.
 */
import { describe, it, expect } from 'vitest';
import type { DriveManifestEntry } from '@/drive-ports';
import { filter_drive_entries } from '@/shared/entry-filter';

const ITEM_ID = '01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3';

const ENTRY = {
  file_id: ITEM_ID,
  file_name: 'Report.docx',
  parent_path: '/Documents',
  change_type: 'created',
  storage_key: 'onedrive/data/o/abc',
} as DriveManifestEntry;

const ROOT_ENTRY = {
  file_id: '01ROOTIDROOTIDROOTID',
  file_name: 'Report.docx',
  // Graph reports `/` both when it omits the parent reference and when the path ends at `root:`.
  parent_path: '/',
  change_type: 'created',
  storage_key: 'onedrive/data/o/def',
} as DriveManifestEntry;

describe('drive file_filter', () => {
  it('matches an item id pasted verbatim from a listing', () => {
    expect(filter_drive_entries([ENTRY], [ITEM_ID])).toHaveLength(1);
  });

  it('matches an item id typed in any case', () => {
    expect(filter_drive_entries([ENTRY], [ITEM_ID.toLowerCase()])).toHaveLength(1);
  });

  it('still matches by path', () => {
    expect(filter_drive_entries([ENTRY], ['/documents/report.docx'])).toHaveLength(1);
  });

  it('excludes what was not asked for', () => {
    expect(filter_drive_entries([ENTRY], ['/Documents/Other.docx'])).toHaveLength(0);
  });

  it('returns everything when no filter is given', () => {
    expect(filter_drive_entries([ENTRY], [])).toHaveLength(1);
  });

  it('matches a file at the drive root by the path an operator would type (issue #299)', () => {
    expect(filter_drive_entries([ROOT_ENTRY], ['/Report.docx'])).toHaveLength(1);
  });

  it('does not match a root-level file by the doubled-slash path it used to build', () => {
    expect(filter_drive_entries([ROOT_ENTRY], ['//Report.docx'])).toHaveLength(0);
  });
});
