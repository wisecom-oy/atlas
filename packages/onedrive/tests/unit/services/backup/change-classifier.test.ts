import { describe, it, expect, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import { classify_change_type } from '@/services/backup/change-classifier';

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 2048,
    kind: 'file',
    deleted: false,
    ...overrides,
  } as OneDriveDeltaItem;
}

const PREVIOUS_PATH = { 'item-1': '/Documents' };
const PREVIOUS_NAME = { 'item-1': 'report.docx' };
const PREVIOUS_ETAG = { 'item-1': '"e1"' };

describe('classify_change_type', () => {
  it('returns "created" when no prior state exists', () => {
    expect(classify_change_type(make_item({ etag: '"e1"' }), {}, {}, {})).toBe('created');
  });

  it('returns "updated" when only the etag changed', () => {
    const item = make_item({ etag: '"e2"' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe('updated');
  });

  it('returns "moved" when only the path changed', () => {
    const item = make_item({ parent_path: '/Archive', etag: '"e1"' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe('moved');
  });

  it('returns "moved" when the item moved and its content changed in one delta (issue #297)', () => {
    const item = make_item({ parent_path: '/Archive', etag: '"e2"' });
    // The new content blob records the update; nothing but this label records the old location.
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe('moved');
  });

  it('returns "moved_and_renamed" when path, name and content all changed', () => {
    const item = make_item({ parent_path: '/Archive', file_name: 'report-v2.docx', etag: '"e2"' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe(
      'moved_and_renamed',
    );
  });

  it('returns "renamed" when the name and the content changed together', () => {
    const item = make_item({ file_name: 'report-v2.docx', etag: '"e2"' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe('renamed');
  });

  it('returns "deleted" for a removed item regardless of prior state', () => {
    const item = make_item({ deleted: true, parent_path: '/Archive' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe('deleted');
  });

  it('returns undefined when nothing changed', () => {
    const item = make_item({ etag: '"e1"' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBeUndefined();
  });

  it('returns "updated" when the etag appears where none was recorded', () => {
    const item = make_item({ etag: '"e1"' });
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, {})).toBe('updated');
  });

  it('returns "updated" when the etag disappears', () => {
    const item = make_item();
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, PREVIOUS_ETAG)).toBe('updated');
  });

  it('warns about the missing etags but still reports the move (issue #297)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const item = make_item({ parent_path: '/Archive' });

    // No etag on either side: the move is certain, a content change alongside it is invisible.
    expect(classify_change_type(item, PREVIOUS_PATH, PREVIOUS_NAME, {})).toBe('moved');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing etag'));

    warn.mockRestore();
  });
});
