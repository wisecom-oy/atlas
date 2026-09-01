/**
 * `--file-filter` by item ID never matched: the filter was lowercased and Graph
 * drive item IDs carry uppercase (`01ABCDEF3IOE64NKISMBHZW5RI63OZGLXR`).
 * SharePoint restore was fixed in #75; restore and save on both workloads
 * carried the same defect. Live proof: the same save command returned 0 files
 * before and 1 after.
 */
import { describe, it, expect } from 'vitest';
import type { SharePointManifestEntry } from '@wisecom/atlas-types';
import { filter_sharepoint_entries } from '@/services/shared/entry-filter';

const ITEM_ID = '01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3';

const ENTRY = {
  file_id: ITEM_ID,
  file_name: 'Report.docx',
  parent_path: '/Documents',
  change_type: 'created',
  storage_key: 'sharepoint/data/o/abc',
} as SharePointManifestEntry;

describe('SharePoint file_filter', () => {
  it('matches an item id pasted verbatim from a listing', () => {
    expect(filter_sharepoint_entries([ENTRY], [ITEM_ID])).toHaveLength(1);
  });

  it('matches an item id typed in any case', () => {
    expect(filter_sharepoint_entries([ENTRY], [ITEM_ID.toLowerCase()])).toHaveLength(1);
  });

  it('still matches by path', () => {
    expect(filter_sharepoint_entries([ENTRY], ['/documents/report.docx'])).toHaveLength(1);
  });

  it('excludes what was not asked for', () => {
    expect(filter_sharepoint_entries([ENTRY], ['/Documents/Other.docx'])).toHaveLength(0);
  });

  it('returns everything when no filter is given', () => {
    expect(filter_sharepoint_entries([ENTRY], [])).toHaveLength(1);
  });
});
