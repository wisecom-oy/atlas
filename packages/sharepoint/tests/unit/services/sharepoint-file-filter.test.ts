/**
 * `--file-filter` by item ID never matched: the filter was lowercased and Graph
 * drive item IDs carry uppercase (`01ABCDEF3IOE64NKISMBHZW5RI63OZGLXR`).
 * SharePoint restore was fixed in #75; restore and save on both workloads
 * carried the same defect. Live proof: the same save command returned 0 files
 * before and 1 after.
 */
import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { SharePointRestoreService } from '@/services/sharepoint-restore.service';
import { SharePointSaveService } from '@/services/sharepoint-save.service';
import type { SharePointManifestEntry } from '@wisecom/atlas-types';

const ITEM_ID = '01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3';

const ENTRY = {
  file_id: ITEM_ID,
  file_name: 'Report.docx',
  parent_path: '/Documents',
  change_type: 'created',
  storage_key: 'sharepoint/data/o/abc',
} as SharePointManifestEntry;

interface Filterable {
  filter_entries(
    entries: readonly SharePointManifestEntry[],
    file_filter?: string[],
  ): SharePointManifestEntry[];
}

/** `filter_entries` is private; both services must answer the same way. */
const services: [string, Filterable][] = [
  ['restore', SharePointRestoreService.prototype as unknown as Filterable],
  ['save', SharePointSaveService.prototype as unknown as Filterable],
];

describe.each(services)('%s file_filter', (_name, service) => {
  it('matches an item id pasted verbatim from a listing', () => {
    expect(service.filter_entries([ENTRY], [ITEM_ID])).toHaveLength(1);
  });

  it('matches an item id typed in any case', () => {
    expect(service.filter_entries([ENTRY], [ITEM_ID.toLowerCase()])).toHaveLength(1);
  });

  it('still matches by path', () => {
    expect(service.filter_entries([ENTRY], ['/documents/report.docx'])).toHaveLength(1);
  });

  it('excludes what was not asked for', () => {
    expect(service.filter_entries([ENTRY], ['/Documents/Other.docx'])).toHaveLength(0);
  });

  it('returns everything when no filter is given', () => {
    expect(service.filter_entries([ENTRY], [])).toHaveLength(1);
  });
});
