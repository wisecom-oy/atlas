import { describe, it, expect, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import { classify_change_type } from '@/services/backup/change-classifier';

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 2048,
    kind: 'file',
    deleted: false,
    ...overrides,
  };
}

describe('classify_change_type', () => {
  it('returns "deleted" when item is deleted', () => {
    const item = make_item({ deleted: true });
    expect(classify_change_type(item, {}, {}, {})).toBe('deleted');
  });

  it('returns "created" when no prior state exists', () => {
    const item = make_item();
    expect(classify_change_type(item, {}, {}, {})).toBe('created');
  });

  it('returns "updated" when etag changes', () => {
    const item = make_item({ etag: '"new-etag"' });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"old-etag"' },
      ),
    ).toBe('updated');
  });

  it('returns "moved" when path changes but name stays', () => {
    const item = make_item({ parent_path: '/Archive', etag: '"e1"' });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"e1"' },
      ),
    ).toBe('moved');
  });

  it('returns "renamed" when name changes but path stays', () => {
    const item = make_item({ file_name: 'report-v2.docx', etag: '"e1"' });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"e1"' },
      ),
    ).toBe('renamed');
  });

  it('returns "moved_and_renamed" when both path and name change', () => {
    const item = make_item({ parent_path: '/Archive', file_name: 'old-report.docx', etag: '"e1"' });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"e1"' },
      ),
    ).toBe('moved_and_renamed');
  });

  it('returns "moved" when the item moved and its content changed in one delta (issue #297)', () => {
    const item = make_item({ parent_path: '/Archive', etag: '"e2"' });
    // The new content blob records the update; nothing but this label records the old location.
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"e1"' },
      ),
    ).toBe('moved');
  });

  it('returns "moved_and_renamed" when path, name and content all changed', () => {
    const item = make_item({
      parent_path: '/Archive',
      file_name: 'report-v2.docx',
      etag: '"e2"',
    });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"e1"' },
      ),
    ).toBe('moved_and_renamed');
  });

  it('returns "renamed" when the name and the content changed together', () => {
    const item = make_item({ file_name: 'report-v2.docx', etag: '"e2"' });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"e1"' },
      ),
    ).toBe('renamed');
  });

  it('returns undefined when nothing changed', () => {
    const item = make_item({ etag: '"same"' });
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"same"' },
      ),
    ).toBeUndefined();
  });

  it('returns "updated" on etag appearing when previously missing', () => {
    const item = make_item({ etag: '"new"' });
    expect(
      classify_change_type(item, { 'item-1': '/Documents' }, { 'item-1': 'report.docx' }, {}),
    ).toBe('updated');
  });

  it('returns "updated" on etag disappearing when previously present', () => {
    const item = make_item();
    expect(
      classify_change_type(
        item,
        { 'item-1': '/Documents' },
        { 'item-1': 'report.docx' },
        { 'item-1': '"old"' },
      ),
    ).toBe('updated');
  });

  it('returns "updated" when both prior and current etag are missing but item is known', () => {
    const item = make_item();
    expect(classify_change_type(item, { 'item-1': '/Documents' }, {}, {})).toBe('updated');
  });

  it('warns about the missing etags but still reports the move (issue #297)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const item = make_item({ parent_path: '/Archive' });

    // No etag on either side: the move is certain, a content change alongside it is invisible.
    expect(
      classify_change_type(item, { 'item-1': '/Documents' }, { 'item-1': 'report.docx' }, {}),
    ).toBe('moved');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing etag'));

    warn.mockRestore();
  });
});
