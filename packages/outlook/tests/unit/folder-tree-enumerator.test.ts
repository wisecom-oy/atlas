import { describe, it, expect, vi } from 'vitest';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { enumerate_folder_tree } from '@/adapters/graph-folder-tree-enumerator';

/** Fake Graph paging: maps a parent folder id (or 'root') to its children. */
function fetcher(tree: Record<string, GraphFolderRecord[]>) {
  return vi.fn(async (parent_folder_id?: string) => tree[parent_folder_id ?? 'root'] ?? []);
}

describe('enumerate_folder_tree', () => {
  it('flattens the hierarchy with a root-relative path per folder', async () => {
    const folders = await enumerate_folder_tree(
      fetcher({
        root: [
          { id: 'inbox', displayName: 'Inbox', childFolderCount: 2 },
          { id: 'sent', displayName: 'Sent Items' },
        ],
        inbox: [
          { id: 'projects', displayName: 'Projects', childFolderCount: 1 },
          { id: 'receipts', displayName: 'Receipts' },
        ],
        projects: [{ id: 'y2026', displayName: '2026' }],
      }),
    );

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Inbox',
      'Inbox/Projects',
      'Inbox/Projects/2026',
      'Inbox/Receipts',
      'Sent Items',
    ]);
  });

  it('keeps the leaf name in display_name while the path carries the ancestry', async () => {
    const [, nested] = await enumerate_folder_tree(
      fetcher({
        root: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 1 }],
        inbox: [{ id: 'y2026', displayName: '2026', totalItemCount: 7 }],
      }),
    );

    expect(nested).toEqual({
      folder_id: 'y2026',
      display_name: '2026',
      folder_path: 'Inbox/2026',
      parent_folder_id: undefined,
      total_item_count: 7,
    });
  });

  it('prunes excluded folders together with their subtree', async () => {
    const fetch_children = fetcher({
      root: [{ id: 'junk', displayName: 'JunkEmail', childFolderCount: 1 }],
      junk: [{ id: 'junk-child', displayName: 'Old spam' }],
    });

    const folders = await enumerate_folder_tree(fetch_children);

    expect(folders).toEqual([]);
    expect(fetch_children).toHaveBeenCalledTimes(1);
  });

  it('skips records Graph returned without an id', async () => {
    const folders = await enumerate_folder_tree(fetcher({ root: [{ displayName: 'Ghost' }] }));
    expect(folders).toEqual([]);
  });

  it('stops descending at the Exchange depth ceiling instead of recursing forever', async () => {
    // Every folder claims a child, so only the depth cap can end the walk.
    const fetch_children = vi.fn(async (parent_folder_id?: string) => [
      {
        id: `${parent_folder_id ?? 'root'}-child`,
        displayName: 'deeper',
        childFolderCount: 1,
      },
    ]);

    const folders = await enumerate_folder_tree(fetch_children);

    expect(folders).toHaveLength(300);
    expect(fetch_children).toHaveBeenCalledTimes(300);
  });
});
