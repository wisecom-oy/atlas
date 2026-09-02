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

  it('backs up Drafts and Outbox, which a preview-mode filter used to prune', async () => {
    const fetch_children = fetcher({
      root: [
        { id: 'inbox', displayName: 'Inbox' },
        { id: 'drafts', displayName: 'Drafts' },
        { id: 'outbox', displayName: 'Outbox' },
      ],
    });

    const folders = await enumerate_folder_tree(fetch_children);

    expect(folders.map((f) => f.display_name)).toEqual(['Inbox', 'Drafts', 'Outbox']);
  });

  it('backs up Junk Email by default', async () => {
    const fetch_children = fetcher({
      root: [{ id: 'junk', displayName: 'Junk Email', childFolderCount: 1 }],
      junk: [{ id: 'junk-child', displayName: 'Old spam' }],
    });

    const folders = await enumerate_folder_tree(fetch_children);

    expect(folders.map((f) => f.display_name)).toEqual(['Junk Email', 'Old spam']);
  });

  it('prunes Junk Email with its subtree when asked, and reports it', async () => {
    const fetch_children = fetcher({
      root: [{ id: 'junk', displayName: 'Junk Email', childFolderCount: 1 }],
      junk: [{ id: 'junk-child', displayName: 'Old spam' }],
    });
    const excluded: Array<{ folder_path: string; reason: string }> = [];

    const folders = await enumerate_folder_tree(fetch_children, {
      exclude_junk: true,
      on_excluded: (e) => excluded.push(e),
    });

    expect(folders).toEqual([]);
    // The child is never fetched: pruning takes the whole subtree.
    expect(fetch_children).toHaveBeenCalledTimes(1);
    expect(excluded).toEqual([{ folder_path: 'Junk Email', reason: 'junk-excluded' }]);
  });

  it('prunes a hidden system folder but keeps a visible folder of the same name', async () => {
    const excluded: Array<{ folder_path: string; reason: string }> = [];
    const folders = await enumerate_folder_tree(
      fetcher({
        root: [
          { id: 'h', displayName: 'Working Set', isHidden: true },
          { id: 'v', displayName: 'Working Set', isHidden: false },
        ],
      }),
      { on_excluded: (e) => excluded.push(e) },
    );

    expect(folders.map((f) => f.folder_id)).toEqual(['v']);
    expect(excluded).toEqual([{ folder_path: 'Working Set', reason: 'hidden-system-folder' }]);
  });

  it('keeps a hidden folder that is not a known system folder, recording it as hidden', async () => {
    const folders = await enumerate_folder_tree(
      fetcher({ root: [{ id: 'c', displayName: 'Clutter', isHidden: true }] }),
    );

    expect(folders).toHaveLength(1);
    expect(folders[0]?.is_hidden).toBe(true);
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
