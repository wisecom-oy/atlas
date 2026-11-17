import { describe, it, expect, vi } from 'vitest';
import type { ExcludedFolder } from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { enumerate_folder_tree } from '@/adapters/graph-folder-tree-enumerator';

/** A Graph error carrying `statusCode`, as the SDK raises it. */
function graph_error(status_code: number, code: string): Error {
  return Object.assign(new Error(code), { statusCode: status_code, code });
}

/** Fake Graph paging that rejects the listing of every parent id in `failing`. */
function fetcher(tree: Record<string, GraphFolderRecord[]>, failing: Record<string, Error> = {}) {
  return vi.fn(async (parent_folder_id?: string) => {
    const key = parent_folder_id ?? 'root';
    const failure = failing[key];
    if (failure) throw failure;
    return tree[key] ?? [];
  });
}

const TREE: Record<string, GraphFolderRecord[]> = {
  root: [
    { id: 'inbox', displayName: 'Inbox', childFolderCount: 1 },
    { id: 'example', displayName: 'Example Folder', childFolderCount: 1 },
    { id: 'sent', displayName: 'Sent Items' },
  ],
  inbox: [{ id: 'receipts', displayName: 'Receipts' }],
  example: [{ id: 'child', displayName: 'Child' }],
};

describe('enumerate_folder_tree - a folder deleted during the listing (issue #690)', () => {
  it('skips a folder whose child listing answers 404 and returns every other folder', async () => {
    const excluded: ExcludedFolder[] = [];

    const folders = await enumerate_folder_tree(
      fetcher(TREE, { example: graph_error(404, 'ErrorItemNotFound') }),
      { on_excluded: (folder) => excluded.push(folder) },
    );

    expect(folders.map((f) => f.folder_path)).toEqual(['Inbox', 'Inbox/Receipts', 'Sent Items']);
    expect(excluded).toEqual([{ folder_path: 'Example Folder', reason: 'deleted-during-listing' }]);
  });

  it('keeps the parent when only a deeper folder vanished', async () => {
    const tree = {
      ...TREE,
      example: [{ id: 'child', displayName: 'Child', childFolderCount: 1 }],
    };

    const folders = await enumerate_folder_tree(
      fetcher(tree, { child: graph_error(404, 'ErrorItemNotFound') }),
    );

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Inbox',
      'Inbox/Receipts',
      'Example Folder',
      'Sent Items',
    ]);
  });

  it('still fails on a 404 for the root listing, which means the mailbox is gone', async () => {
    const listing = enumerate_folder_tree(
      fetcher(TREE, { root: graph_error(404, 'ErrorItemNotFound') }),
    );

    await expect(listing).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([403, 500])('still fails when a child listing answers %i', async (status_code) => {
    const listing = enumerate_folder_tree(
      fetcher(TREE, { example: graph_error(status_code, 'Failure') }),
    );

    await expect(listing).rejects.toMatchObject({ statusCode: status_code });
  });
});
