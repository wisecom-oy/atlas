import { describe, expect, it } from 'vitest';
import { apply_overrides, type Overrides } from '@wisecom/atlas-types/testing/apply-overrides';
import type { OneDriveFileVersionIndex, OneDriveFileVersionRecord } from '@wisecom/atlas-types';
import { select_versions_to_restore } from '@/services/versioning/version-selection';

const OWNER = 'owner-1';
const ATTACK = new Date('2026-03-10T00:00:00Z');

function version(overrides: Overrides<OneDriveFileVersionRecord> = {}): OneDriveFileVersionRecord {
  return apply_overrides<OneDriveFileVersionRecord>(
    {
      snapshot_id: 'snap-1',
      backup_at: '2026-03-01T00:00:00.000Z',
      drive_id: 'drive-1',
      file_name: 'Report.docx',
      parent_path: '/Documents',
      size_bytes: 100,
      storage_key: 'onedrive/data/owner-1/abc',
      checksum: 'abc',
      change_type: 'updated',
      last_modified_at: '2026-03-01T00:00:00.000Z',
      version_id: '1.0',
    } as OneDriveFileVersionRecord,
    overrides,
  );
}

function index(file_id: string, versions: OneDriveFileVersionRecord[]): OneDriveFileVersionIndex {
  return { file_id, owner_id: OWNER, versions };
}

describe('select_versions_to_restore', () => {
  it('requires either a file reference or a cutoff', () => {
    expect(() => select_versions_to_restore([], {})).toThrow(/file reference|--before/);
  });

  it('selects one exact version by id', () => {
    const indexes = [
      index('file-1', [
        version({ version_id: '1.0' }),
        version({ version_id: '2.0', last_modified_at: '2026-03-05T00:00:00.000Z' }),
      ]),
    ];

    const { selected } = select_versions_to_restore(indexes, {
      file_ref: '/Documents/Report.docx',
      version_id: '1.0',
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.version.version_id).toBe('1.0');
    expect(selected[0]?.original_path).toBe('/Documents/Report.docx');
  });

  it('lists the stored version ids when the requested one is absent', () => {
    const indexes = [index('file-1', [version({ version_id: '1.0' })])];

    expect(() =>
      select_versions_to_restore(indexes, { file_ref: 'file-1', version_id: '9.0' }),
    ).toThrow(/Stored: 1\.0/);
  });

  it('refuses an exact version whose content was never stored', () => {
    const indexes = [
      index('file-1', [
        version({ version_id: '1.0', storage_key: undefined, checksum: undefined }),
      ]),
    ];

    // Graph lists versions Atlas could not download; selecting one would fail
    // later with a confusing decrypt error instead of an honest refusal.
    expect(() =>
      select_versions_to_restore(indexes, { file_ref: 'file-1', version_id: '1.0' }),
    ).toThrow(/no stored content/);
  });

  it('rejects an unknown file reference', () => {
    expect(() =>
      select_versions_to_restore([index('file-1', [version()])], { file_ref: '/nope.docx' }),
    ).toThrow(/No stored versions found/);
  });

  it('requires a version or a cutoff once a file is named', () => {
    expect(() =>
      select_versions_to_restore([index('file-1', [version()])], { file_ref: 'file-1' }),
    ).toThrow(/--version or --before/);
  });

  it('picks the newest version at or before the cutoff', () => {
    const indexes = [
      index('file-1', [
        version({ version_id: '1.0', last_modified_at: '2026-03-01T00:00:00.000Z' }),
        version({ version_id: '2.0', last_modified_at: '2026-03-09T23:59:59.000Z' }),
        version({ version_id: '3.0', last_modified_at: '2026-03-10T00:00:01.000Z' }),
      ]),
    ];

    const { selected } = select_versions_to_restore(indexes, { before: ATTACK });

    // 3.0 is the poisoned one, a second past the cutoff.
    expect(selected[0]?.version.version_id).toBe('2.0');
  });

  it('includes a version exactly at the cutoff', () => {
    const indexes = [
      index('file-1', [version({ version_id: '1.0', last_modified_at: ATTACK.toISOString() })]),
    ];

    const { selected } = select_versions_to_restore(indexes, { before: ATTACK });

    expect(selected).toHaveLength(1);
  });

  it('reports a file whose every version is newer than the cutoff', () => {
    const indexes = [
      index('file-1', [
        version({ version_id: '9.0', last_modified_at: '2026-03-20T00:00:00.000Z' }),
      ]),
    ];

    const { selected, skipped } = select_versions_to_restore(indexes, { before: ATTACK });

    // Silence here would read as "everything rolled back" when this file has
    // no pre-attack copy at all.
    expect(selected).toHaveLength(0);
    expect(skipped).toEqual(['/Documents/Report.docx: no stored version at or before the cutoff']);
  });

  it('falls back to the backup time when a row carries no modification time', () => {
    const indexes = [
      index('file-1', [
        version({
          version_id: undefined,
          last_modified_at: undefined,
          backup_at: '2026-03-02T00:00:00.000Z',
        }),
      ]),
    ];

    const { selected } = select_versions_to_restore(indexes, { before: ATTACK });

    // Rows copied from a manifest entry carry no version id or service time.
    expect(selected).toHaveLength(1);
  });

  it('skips a version with an unparseable timestamp rather than restoring it', () => {
    const indexes = [
      index('file-1', [version({ last_modified_at: 'not-a-date', backup_at: 'also-not' })]),
    ];

    const { selected, skipped } = select_versions_to_restore(indexes, { before: ATTACK });

    expect(selected).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('rolls back every file in the drive when no path scope is given', () => {
    const indexes = [
      index('file-1', [version({ file_name: 'A.docx' })]),
      index('file-2', [version({ file_name: 'B.docx', parent_path: '/Other' })]),
    ];

    const { selected } = select_versions_to_restore(indexes, { before: ATTACK });

    expect(selected).toHaveLength(2);
  });

  it('limits a rollback to the path scope', () => {
    const indexes = [
      index('file-1', [version({ parent_path: '/Documents' })]),
      index('file-2', [version({ parent_path: '/Pictures' })]),
    ];

    const { selected } = select_versions_to_restore(indexes, {
      before: ATTACK,
      path_prefix: '/Documents',
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.file_id).toBe('file-1');
  });

  it('does not let a path scope capture a sibling with a shared prefix', () => {
    const indexes = [
      index('file-1', [version({ parent_path: '/Docs' })]),
      index('file-2', [version({ parent_path: '/Docs Archive' })]),
    ];

    const { selected } = select_versions_to_restore(indexes, {
      before: ATTACK,
      path_prefix: '/Docs',
    });

    // '/Docs Archive' starts with '/Docs' as a string but is a different folder.
    expect(selected.map((s) => s.file_id)).toEqual(['file-1']);
  });

  it('accepts a path scope without a leading slash or with backslashes', () => {
    const indexes = [index('file-1', [version({ parent_path: '/Documents' })])];

    for (const path_prefix of ['Documents', '\\Documents', '/Documents/']) {
      const { selected } = select_versions_to_restore(indexes, { before: ATTACK, path_prefix });
      expect(selected, path_prefix).toHaveLength(1);
    }
  });

  it('ignores versions with no stored bytes when picking the newest', () => {
    const indexes = [
      index('file-1', [
        version({ version_id: '1.0', last_modified_at: '2026-03-01T00:00:00.000Z' }),
        version({
          version_id: '2.0',
          last_modified_at: '2026-03-05T00:00:00.000Z',
          storage_key: undefined,
        }),
      ]),
    ];

    const { selected } = select_versions_to_restore(indexes, { before: ATTACK });

    // 2.0 is newer but its bytes were never captured, so it cannot be restored.
    expect(selected[0]?.version.version_id).toBe('1.0');
  });

  it('selects one file by reference and cutoff together', () => {
    const indexes = [
      index('file-1', [
        version({ version_id: '1.0', last_modified_at: '2026-03-01T00:00:00.000Z' }),
        version({ version_id: '5.0', last_modified_at: '2026-03-30T00:00:00.000Z' }),
      ]),
      index('file-2', [version({ parent_path: '/Other', file_name: 'B.docx' })]),
    ];

    const { selected } = select_versions_to_restore(indexes, {
      file_ref: '/Documents/Report.docx',
      before: ATTACK,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.version.version_id).toBe('1.0');
  });
});
