import { describe, expect, it } from 'vitest';
import type { DriveManifestEntry } from '@/drive-ports';
import { folder_colors_not_restored } from '@/restore/folder-color-restore';

function folder_entry(fields: Partial<DriveManifestEntry> = {}): DriveManifestEntry {
  return {
    file_id: 'f',
    drive_id: 'drive-1',
    file_name: 'Projects',
    parent_path: '/',
    size_bytes: 0,
    backup_at: '2026-11-01T00:00:00Z',
    change_type: 'created',
    kind: 'folder',
    ...fields,
  };
}

describe('folder_colors_not_restored (#581)', () => {
  it('counts the selected folders that carry a colour', () => {
    expect(
      folder_colors_not_restored([
        folder_entry({ file_id: 'a', folder_color: { color_hex: '6' } }),
        folder_entry({ file_id: 'b', folder_color: { emoji: 'star' } }),
        folder_entry({ file_id: 'c', permissions: [{ roles: ['read'] }] }),
      ]),
    ).toEqual({ folder_colors_not_restored: 2 });
  });

  it('adds no field when nothing is coloured, so older restores read as before', () => {
    expect(
      folder_colors_not_restored([folder_entry(), folder_entry({ folder_color: {} })]),
    ).toEqual({});
    expect(folder_colors_not_restored([])).toEqual({});
  });
});
