/**
 * Issue #707: a `--file-filter` that matched no file restored or saved nothing and exited 0.
 * A filter that matches nothing at all now rejects with NotFoundError; values that match nothing
 * beside values that do are returned so the run can report itself partial.
 */
import { describe, it, expect } from 'vitest';
import { NotFoundError } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';
import {
  filter_drive_entries,
  select_drive_entries,
  with_unmatched_file_filters,
} from '@/shared/entry-filter';

const ENTRY = {
  file_id: '01ITEMIDITEMIDITEMID',
  file_name: 'Report.docx',
  parent_path: '/Documents',
  change_type: 'created',
  storage_key: 'onedrive/data/o/abc',
} as DriveManifestEntry;

describe('unmatched file filter values', () => {
  it('lists the values that matched no entry', () => {
    const selection = filter_drive_entries([ENTRY], ['/Documents/Report.docx', '/no/such.txt']);

    expect(selection.entries).toEqual([ENTRY]);
    expect(selection.unmatched_filters).toEqual(['/no/such.txt']);
  });

  it('rejects with NotFoundError naming every value when nothing matched', () => {
    expect(() => select_drive_entries([ENTRY], ['/no/such.txt', 'BADID'])).toThrow(NotFoundError);
    expect(() => select_drive_entries([ENTRY], ['/no/such.txt', 'BADID'])).toThrow(
      'No file in the snapshot matches "/no/such.txt", "BADID"',
    );
  });

  it('does not reject when no filter was given, even for an empty snapshot', () => {
    expect(select_drive_entries([], undefined).entries).toEqual([]);
    expect(select_drive_entries([], []).entries).toEqual([]);
  });

  it('returns the partial selection when some values matched', () => {
    const selection = select_drive_entries([ENTRY], [ENTRY.file_id, '/no/such.txt']);

    expect(selection.entries).toEqual([ENTRY]);
    expect(selection.unmatched_filters).toEqual(['/no/such.txt']);
  });

  it('records unmatched values on a result only when there are some', () => {
    expect(with_unmatched_file_filters({ files: 1 }, [])).toEqual({ files: 1 });
    expect(with_unmatched_file_filters({ files: 1 }, ['/x'])).toEqual({
      files: 1,
      unmatched_file_filters: ['/x'],
    });
  });
});
