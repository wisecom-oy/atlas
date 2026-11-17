import { describe, expect, it } from 'vitest';
import { resolve_backed_up_kind } from '@/backup/backed-up-item-kind';

describe('resolve_backed_up_kind', () => {
  it('keeps the kind Graph reports for a live item', () => {
    expect(resolve_backed_up_kind({ item_id: 'a', kind: 'folder', deleted: false }, {})).toBe(
      'folder',
    );
    expect(
      resolve_backed_up_kind({ item_id: 'a', kind: 'file', deleted: false }, { a: 'folder' }),
    ).toBe('file');
  });

  it('uses the recorded kind for a deletion, which Graph reports as a file', () => {
    expect(
      resolve_backed_up_kind({ item_id: 'a', kind: 'file', deleted: true }, { a: 'folder' }),
    ).toBe('folder');
  });

  it('treats a deletion the cursor never saw as a file', () => {
    expect(resolve_backed_up_kind({ item_id: 'a', kind: 'file', deleted: true }, {})).toBe('file');
  });
});
