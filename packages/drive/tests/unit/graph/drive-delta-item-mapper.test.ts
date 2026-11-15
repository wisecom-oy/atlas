import { describe, expect, it } from 'vitest';
import { classify_drive_item_kind, map_drive_delta_item } from '@/graph/drive-delta-item-mapper';
import { DRIVE_DELTA_SELECT_FIELDS } from '@/graph/graph-drive-item';

describe('drive delta item mapping (#580)', () => {
  it('selects the facets classification and permission capture read', () => {
    for (const field of ['shared', 'root', 'file', 'folder', 'deleted']) {
      expect(DRIVE_DELTA_SELECT_FIELDS.split(',')).toContain(field);
    }
  });

  it('keeps files, folders and deletions classified as before', () => {
    expect(classify_drive_item_kind({ file: {} }, false)).toBe('file');
    expect(classify_drive_item_kind({ folder: {} }, false)).toBe('folder');
    expect(classify_drive_item_kind({}, true)).toBe('file');
    expect(classify_drive_item_kind({ package: { type: 'oneNote' } }, false)).toBe('folder');
  });

  it('marks the drive root and items that carry a shared facet, empty or not', () => {
    const root = map_drive_delta_item({ id: 'r', name: 'root', folder: {}, root: {} }, 'd');
    const unshared = map_drive_delta_item({ id: 'f', name: 'a', file: {}, shared: {} }, 'd');
    const plain = map_drive_delta_item({ id: 'g', name: 'b', file: {} }, 'd');

    expect(root.is_root).toBe(true);
    expect(unshared.sharing_facet).toBe(true);
    expect(plain.sharing_facet).toBeUndefined();
    expect(plain.is_root).toBeUndefined();
  });
});
