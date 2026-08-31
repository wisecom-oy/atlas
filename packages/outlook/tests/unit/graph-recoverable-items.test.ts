import { describe, expect, it, vi } from 'vitest';
import type { ExcludedFolder } from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import {
  enumerate_recoverable_items,
  RECOVERABLE_ITEMS_ANCHOR,
} from '@/adapters/graph-recoverable-items';

const ROOT_ID = 'recoverable-root';

/** The dumpster as Exchange presents it: the anchor names its own parent. */
function make_reader(parent = ROOT_ID) {
  return vi.fn(async (ref: string): Promise<GraphFolderRecord | undefined> => {
    if (ref !== RECOVERABLE_ITEMS_ANCHOR) return undefined;
    return { id: 'f-deletions', displayName: 'Deletions', parentFolderId: parent };
  });
}

function folder(overrides: Partial<GraphFolderRecord>): GraphFolderRecord {
  return { id: 'f-x', displayName: 'X', parentFolderId: ROOT_ID, totalItemCount: 0, ...overrides };
}

const FULL_DUMPSTER: GraphFolderRecord[] = [
  folder({ id: 'f-deletions', displayName: 'Deletions', totalItemCount: 173 }),
  folder({ id: 'f-purges', displayName: 'Purges', totalItemCount: 4 }),
  folder({ id: 'f-discovery', displayName: 'DiscoveryHolds', totalItemCount: 2 }),
  folder({ id: 'f-substrate', displayName: 'SubstrateHolds', totalItemCount: 7 }),
  folder({ id: 'f-versions', displayName: 'Versions', totalItemCount: 11 }),
  folder({ id: 'f-callog', displayName: 'Calendar Logging', totalItemCount: 26 }),
  folder({ id: 'f-audits', displayName: 'Audits', totalItemCount: 900 }),
];

describe('enumerate_recoverable_items', () => {
  it('locates the subtree through the documented anchor folder, not a root name', async () => {
    const read_folder = make_reader();

    await enumerate_recoverable_items(read_folder, async () => FULL_DUMPSTER);

    // 'recoverableitemsroot' answers today but appears in no published list of
    // well-known folder names.
    expect(read_folder).toHaveBeenCalledWith(RECOVERABLE_ITEMS_ANCHOR);
    expect(read_folder).toHaveBeenCalledTimes(1);
  });

  it('captures the four mail subfolders', async () => {
    const folders = await enumerate_recoverable_items(make_reader(), async () => FULL_DUMPSTER);

    expect(folders.map((f) => f.display_name)).toEqual([
      'Deletions',
      'Purges',
      'DiscoveryHolds',
      'SubstrateHolds',
    ]);
  });

  it('captures DiscoveryHolds, which issue #141 omits', async () => {
    const folders = await enumerate_recoverable_items(make_reader(), async () => FULL_DUMPSTER);

    // It holds hard-deleted items under an In-Place Hold or retention policy:
    // the same content as Purges arriving through a different hold.
    expect(folders.some((f) => f.display_name === 'DiscoveryHolds')).toBe(true);
  });

  it('prefixes every path so a dumpster folder is distinguishable from a mailbox folder', async () => {
    const folders = await enumerate_recoverable_items(make_reader(), async () => FULL_DUMPSTER);

    expect(folders.map((f) => f.folder_path)).toContain('Recoverable Items/Purges');
  });

  it('marks every captured folder as recoverable items', async () => {
    const folders = await enumerate_recoverable_items(make_reader(), async () => FULL_DUMPSTER);

    expect(folders.every((f) => f.is_recoverable_items === true)).toBe(true);
  });

  it('reports the non-mail subfolders as skipped rather than dropping them', async () => {
    const excluded: ExcludedFolder[] = [];

    await enumerate_recoverable_items(make_reader(), async () => FULL_DUMPSTER, {
      on_excluded: (folder_excluded) => excluded.push(folder_excluded),
    });

    expect(excluded).toEqual([
      { folder_path: 'Recoverable Items/Versions', reason: 'recoverable-items-not-mail' },
      { folder_path: 'Recoverable Items/Calendar Logging', reason: 'recoverable-items-not-mail' },
      { folder_path: 'Recoverable Items/Audits', reason: 'recoverable-items-not-mail' },
    ]);
  });

  it('reports an unknown subfolder rather than guessing at it', async () => {
    const excluded: ExcludedFolder[] = [];

    const folders = await enumerate_recoverable_items(
      make_reader(),
      async () => [folder({ id: 'f-new', displayName: 'SomethingNew' })],
      { on_excluded: (f) => excluded.push(f) },
    );

    // A localised mailbox, or a subfolder Microsoft adds later, then produces a
    // visible gap instead of silence.
    expect(folders).toHaveLength(0);
    expect(excluded).toEqual([
      { folder_path: 'Recoverable Items/SomethingNew', reason: 'recoverable-items-unrecognised' },
    ]);
  });

  it('matches subfolder names case-insensitively', async () => {
    const folders = await enumerate_recoverable_items(make_reader(), async () => [
      folder({ id: 'f-p', displayName: 'PURGES' }),
    ]);

    expect(folders).toHaveLength(1);
  });

  it('returns nothing when the mailbox has no dumpster', async () => {
    const read_folder = vi.fn(async () => undefined);
    const fetch_children = vi.fn(async () => []);

    const folders = await enumerate_recoverable_items(read_folder, fetch_children);

    expect(folders).toEqual([]);
    // No root means no listing request is spent looking for children.
    expect(fetch_children).not.toHaveBeenCalled();
  });

  it('returns nothing when the anchor folder reports no parent', async () => {
    const read_folder = vi.fn(async () => ({ id: 'f-deletions', displayName: 'Deletions' }));

    const folders = await enumerate_recoverable_items(read_folder, async () => FULL_DUMPSTER);

    expect(folders).toEqual([]);
  });

  it('walks nested folders inside a mail subfolder, keeping the prefix', async () => {
    const fetch_children = vi.fn(async (parent_folder_id: string) => {
      if (parent_folder_id === ROOT_ID) {
        return [folder({ id: 'f-purges', displayName: 'Purges', childFolderCount: 1 })];
      }
      if (parent_folder_id === 'f-purges') {
        return [folder({ id: 'f-nested', displayName: 'Nested', parentFolderId: 'f-purges' })];
      }
      return [];
    });

    const folders = await enumerate_recoverable_items(make_reader(), fetch_children);

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Recoverable Items/Purges',
      'Recoverable Items/Purges/Nested',
    ]);
    expect(folders.every((f) => f.is_recoverable_items === true)).toBe(true);
  });

  it('carries the item count so the run can size the work', async () => {
    const folders = await enumerate_recoverable_items(make_reader(), async () => FULL_DUMPSTER);

    expect(folders.find((f) => f.display_name === 'Deletions')?.total_item_count).toBe(173);
  });
});
