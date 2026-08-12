/**
 * `--file-filter` by item ID never matched: the filter was lowercased and Graph
 * drive item IDs carry uppercase (`01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3`).
 * SharePoint restore was fixed in #75; restore and save on both workloads
 * carried the same defect. Live proof: the same save command returned 0 files
 * before and 1 after.
 */
import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { OneDriveRestoreService } from '@/services/onedrive-restore.service';
import { OneDriveSaveService } from '@/services/onedrive-save.service';
import type { OneDriveManifestEntry } from '@wisecom/atlas-types';

const ITEM_ID = '01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3';

const ENTRY = {
  file_id: ITEM_ID,
  file_name: 'Report.docx',
  parent_path: '/Documents',
  change_type: 'created',
  storage_key: 'onedrive/data/o/abc',
} as OneDriveManifestEntry;

interface Filterable {
  filter_entries(
    entries: readonly OneDriveManifestEntry[],
    file_filter?: string[],
  ): OneDriveManifestEntry[];
}

/** `filter_entries` is private; both services must answer the same way. */
const services: [string, Filterable][] = [
  ['restore', OneDriveRestoreService.prototype as unknown as Filterable],
  ['save', OneDriveSaveService.prototype as unknown as Filterable],
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
