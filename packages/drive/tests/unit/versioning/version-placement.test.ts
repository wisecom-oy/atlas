import { describe, expect, it } from 'vitest';
import { apply_overrides, type Overrides } from '@wisecom/atlas-types/testing/apply-overrides';
import type { DriveFileVersionRecord } from '@/drive-ports';
import { build_restored_file_name, split_parent_path } from '@/versioning/version-placement';

function version(overrides: Overrides<DriveFileVersionRecord> = {}): DriveFileVersionRecord {
  return apply_overrides<DriveFileVersionRecord>(
    {
      snapshot_id: 'snap-1',
      backup_at: '2026-03-02T09:30:00.000Z',
      drive_id: 'drive-1',
      file_name: 'Report.docx',
      parent_path: '/Documents',
      size_bytes: 10,
      change_type: 'updated',
      last_modified_at: '2026-03-01T08:15:00.000Z',
    } as DriveFileVersionRecord,
    overrides,
  );
}

describe('split_parent_path', () => {
  it('splits a nested path', () => {
    expect(split_parent_path('/Documents/Reports/Q1.docx')).toEqual({
      parent_path: '/Documents/Reports',
      file_name: 'Q1.docx',
    });
  });

  it('treats a file at the drive root as living in the root folder', () => {
    expect(split_parent_path('/Report.docx')).toEqual({
      parent_path: '/',
      file_name: 'Report.docx',
    });
  });
});

describe('build_restored_file_name', () => {
  it('keeps the original name in place', () => {
    expect(build_restored_file_name(version(), 'in-place')).toBe('Report.docx');
  });

  it('stamps the version time before the extension for a copy', () => {
    // The extension has to survive, or Office refuses to open the recovery.
    expect(build_restored_file_name(version(), 'copy')).toBe(
      'Report (restored 2026-03-01T08-15-00Z).docx',
    );
  });

  it('never puts a colon in a name it creates', () => {
    const name = build_restored_file_name(version(), 'copy');

    // Colons are legal in OneDrive and illegal on Windows, and Atlas exports
    // these files into zip archives that land on Windows.
    expect(name).not.toContain(':');
  });

  it('falls back to the backup time when no modification time was recorded', () => {
    const name = build_restored_file_name(version({ last_modified_at: undefined }), 'copy');

    expect(name).toBe('Report (restored 2026-03-02T09-30-00Z).docx');
  });

  it('appends to a name with no extension', () => {
    expect(build_restored_file_name(version({ file_name: 'README' }), 'copy')).toBe(
      'README (restored 2026-03-01T08-15-00Z)',
    );
  });

  it('treats a dotfile name as having no extension', () => {
    // '.gitignore' is the whole name, so splitting on the dot would produce
    // ' (restored ...).gitignore' with an empty stem.
    expect(build_restored_file_name(version({ file_name: '.gitignore' }), 'copy')).toBe(
      '.gitignore (restored 2026-03-01T08-15-00Z)',
    );
  });

  it('uses the last dot in a multi-extension name', () => {
    expect(build_restored_file_name(version({ file_name: 'backup.tar.gz' }), 'copy')).toBe(
      'backup.tar (restored 2026-03-01T08-15-00Z).gz',
    );
  });

  it('keeps an unparseable timestamp verbatim rather than printing Invalid Date', () => {
    const name = build_restored_file_name(
      version({ last_modified_at: 'garbage', backup_at: 'garbage' }),
      'copy',
    );

    expect(name).toBe('Report (restored garbage).docx');
    expect(name).not.toContain('Invalid');
  });
});
