import { describe, expect, it } from 'vitest';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { resolve_file_id, version_logical_path } from '@/versioning/version-reference';

function version(
  file_name: string,
  parent_path: string,
  snapshot_id = 'snap-1',
): DriveFileVersionRecord {
  return {
    snapshot_id,
    backup_at: '2026-03-01T00:00:00Z',
    drive_id: 'drive-1',
    file_name,
    parent_path,
    version_id: 'v1',
    size_bytes: 10,
    storage_key: 'onedrive/data/o/abc',
    checksum: 'abc',
    last_modified_at: '2026-03-01T00:00:00Z',
    change_type: 'updated',
  } as DriveFileVersionRecord;
}

function index(file_id: string, versions: DriveFileVersionRecord[]): DriveFileVersionIndexView {
  return { file_id, versions };
}

describe('version_logical_path', () => {
  it('does not double the slash for a file at the drive root', () => {
    expect(version_logical_path(version('Report.docx', '/'))).toBe('/Report.docx');
  });

  it('joins a nested path', () => {
    expect(version_logical_path(version('Report.docx', '/Documents'))).toBe(
      '/Documents/Report.docx',
    );
  });
});

describe('resolve_file_id', () => {
  const nested = index('file-a', [version('Report.docx', '/Documents')]);

  it('resolves a file id given verbatim', () => {
    expect(resolve_file_id([nested], 'file-a')).toBe('file-a');
  });

  it('resolves a file id typed in any case and returns the stored spelling', () => {
    const upper = index('01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3', [
      version('Report.docx', '/Documents'),
    ]);

    // Graph item ids carry uppercase; #75 made `--file-filter` case-insensitive for the same
    // reason, and a version reference takes the same identifiers.
    expect(resolve_file_id([upper], '01urrjbn4naektkqyt7bbjabarsnlva5h3')).toBe(
      '01URRJBN4NAEKTKQYT7BBJABARSNLVA5H3',
    );
  });

  it('resolves a path typed in any case', () => {
    expect(resolve_file_id([nested], '/documents/REPORT.docx')).toBe('file-a');
  });

  it('resolves a bare name typed in any case', () => {
    expect(resolve_file_id([nested], 'REPORT.DOCX')).toBe('file-a');
  });

  it('resolves a rooted path', () => {
    expect(resolve_file_id([nested], '/Documents/Report.docx')).toBe('file-a');
  });

  it('resolves a path typed with backslashes and no leading slash', () => {
    expect(resolve_file_id([nested], 'Documents\\Report.docx')).toBe('file-a');
  });

  it('resolves a file at the drive root by its rooted path', () => {
    expect(
      resolve_file_id([index('file-root', [version('Report.docx', '/')])], '/Report.docx'),
    ).toBe('file-root');
  });

  it('returns undefined for a path nothing was indexed under', () => {
    expect(resolve_file_id([nested], '/Documents/Other.docx')).toBeUndefined();
  });

  it('raises when a path maps to two file ids instead of picking the first (issue #300)', () => {
    // A file deleted and recreated at the same path leaves two drive items behind that path.
    const recreated = [
      index('file-old', [version('Report.docx', '/Documents', 'snap-1')]),
      index('file-new', [version('Report.docx', '/Documents', 'snap-2')]),
    ];

    expect(() => resolve_file_id(recreated, '/Documents/Report.docx')).toThrow(
      /matches 2 files: file-new, file-old/,
    );
  });

  it('still raises for a bare name that maps to two files', () => {
    const two = [
      index('file-a', [version('Report.docx', '/Documents')]),
      index('file-b', [version('Report.docx', '/Archive')]),
    ];

    expect(() => resolve_file_id(two, 'Report.docx')).toThrow(/Pass a full path instead/);
  });
});
