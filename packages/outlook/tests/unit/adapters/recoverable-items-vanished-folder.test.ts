import { describe, expect, it, vi } from 'vitest';
import type { ExcludedFolder } from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import {
  enumerate_recoverable_items,
  RECOVERABLE_ITEMS_ANCHOR,
} from '@/adapters/graph-recoverable-items';

const ROOT_ID = 'recoverable-root';
const NOT_FOUND = Object.assign(new Error('ErrorItemNotFound'), {
  statusCode: 404,
  code: 'ErrorItemNotFound',
});

const read_folder = vi.fn(async (ref: string): Promise<GraphFolderRecord | undefined> =>
  ref === RECOVERABLE_ITEMS_ANCHOR
    ? { id: 'f-deletions', displayName: 'Deletions', parentFolderId: ROOT_ID }
    : undefined,
);

/** The dumpster with a Purges subfolder that has children, whose child listing answers `purges`. */
function fetcher(purges: () => GraphFolderRecord[]) {
  return vi.fn(async (parent_folder_id: string): Promise<GraphFolderRecord[]> => {
    if (parent_folder_id === ROOT_ID) {
      return [
        { id: 'f-deletions', displayName: 'Deletions', parentFolderId: ROOT_ID },
        { id: 'f-purges', displayName: 'Purges', parentFolderId: ROOT_ID, childFolderCount: 1 },
        { id: 'f-substrate', displayName: 'SubstrateHolds', parentFolderId: ROOT_ID },
      ];
    }
    if (parent_folder_id === 'f-purges') return purges();
    return [];
  });
}

describe('enumerate_recoverable_items - a subfolder deleted during the listing (issue #690)', () => {
  it('skips the subfolder and its subtree and keeps the others', async () => {
    const excluded: ExcludedFolder[] = [];

    const folders = await enumerate_recoverable_items(
      read_folder,
      fetcher(() => {
        throw NOT_FOUND;
      }),
      { on_excluded: (folder) => excluded.push(folder) },
    );

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Recoverable Items/Deletions',
      'Recoverable Items/SubstrateHolds',
    ]);
    expect(excluded).toEqual([
      { folder_path: 'Recoverable Items/Purges', reason: 'deleted-during-listing' },
    ]);
  });

  it('still captures the subfolder and its children when the listing succeeds', async () => {
    const folders = await enumerate_recoverable_items(
      read_folder,
      fetcher(() => [{ id: 'f-nested', displayName: 'Nested', parentFolderId: 'f-purges' }]),
    );

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Recoverable Items/Deletions',
      'Recoverable Items/Purges',
      'Recoverable Items/Purges/Nested',
      'Recoverable Items/SubstrateHolds',
    ]);
  });

  it('still fails when a subfolder listing answers 403', async () => {
    const listing = enumerate_recoverable_items(
      read_folder,
      fetcher(() => {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      }),
    );

    await expect(listing).rejects.toMatchObject({ statusCode: 403 });
  });
});
