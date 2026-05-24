import { describe, it, expect } from 'vitest';
import type { SharePointDeltaItem } from '@atlas/types';
import { classify_change_type } from '@/services/sharepoint-change-classifier';

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
});
