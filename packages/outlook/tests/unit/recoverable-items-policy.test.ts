import { describe, expect, it, vi } from 'vitest';
import type { ManifestEntry } from '@wisecom/atlas-types';
import {
  apply_recoverable_items_policy,
  is_recoverable_items_entry,
} from '@/services/restore/recoverable-items-filter';
import { list_mail_folder_tree } from '@/adapters/graph-mail-folder-listing';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';

function entry(object_id: string, recoverable?: boolean): ManifestEntry {
  return {
    object_id,
    storage_key: `outlook/data/${object_id}`,
    checksum: 'abc',
    size_bytes: 10,
    ...(recoverable === true ? { recoverable_items: true } : {}),
  } as ManifestEntry;
}

describe('apply_recoverable_items_policy', () => {
  const entries = [entry('normal-1'), entry('purged-1', true), entry('normal-2')];

  it('drops recoverable items by default', () => {
    const kept = apply_recoverable_items_policy(entries, undefined);

    expect(kept.map((e) => e.object_id)).toEqual(['normal-1', 'normal-2']);
  });

  it('keeps them when the caller opts in', () => {
    const kept = apply_recoverable_items_policy(entries, true);

    expect(kept).toHaveLength(3);
  });

  it('drops them when the caller opts out explicitly', () => {
    expect(apply_recoverable_items_policy(entries, false)).toHaveLength(2);
  });

  it('returns the same list when a snapshot holds none', () => {
    const ordinary = [entry('a'), entry('b')];

    expect(apply_recoverable_items_policy(ordinary, undefined)).toHaveLength(2);
  });

  it('identifies an entry only by its own marker, not by any path', () => {
    // A user folder can be named "Recoverable Items", so the flag on the entry
    // is the only trustworthy signal.
    expect(is_recoverable_items_entry(entry('x'))).toBe(false);
    expect(is_recoverable_items_entry(entry('x', true))).toBe(true);
  });
});

describe('list_mail_folder_tree recoverable-items opt-in', () => {
  const visible: GraphFolderRecord[] = [
    { id: 'f-inbox', displayName: 'Inbox', totalItemCount: 42 },
  ];

  it('spends no extra request when the flag is off', async () => {
    const fetch_page = vi.fn(async () => visible);
    const read_folder = vi.fn(async () => undefined);

    const folders = await list_mail_folder_tree(fetch_page, 'owner-1', {}, read_folder);

    expect(folders.map((f) => f.display_name)).toEqual(['Inbox']);
    // Issue #141 requires request volume to be unchanged with the flag off.
    expect(read_folder).not.toHaveBeenCalled();
    expect(fetch_page).toHaveBeenCalledTimes(1);
  });

  it('appends the dumpster folders when the flag is on', async () => {
    const fetch_page = vi.fn(async (url: string) =>
      url.includes('recoverable-root')
        ? [{ id: 'f-purges', displayName: 'Purges', totalItemCount: 4 }]
        : visible,
    );
    const read_folder = vi.fn(async () => ({
      id: 'f-deletions',
      displayName: 'Deletions',
      parentFolderId: 'recoverable-root',
    }));

    const folders = await list_mail_folder_tree(
      fetch_page,
      'owner-1',
      { include_recoverable_items: true },
      read_folder,
    );

    expect(folders.map((f) => f.folder_path)).toEqual(['Inbox', 'Recoverable Items/Purges']);
    expect(folders.find((f) => f.display_name === 'Purges')?.is_recoverable_items).toBe(true);
    expect(folders.find((f) => f.display_name === 'Inbox')?.is_recoverable_items).toBeUndefined();
  });

  it('leaves the visible tree intact when the dumpster cannot be resolved', async () => {
    const fetch_page = vi.fn(async () => visible);
    const read_folder = vi.fn(async () => undefined);

    const folders = await list_mail_folder_tree(
      fetch_page,
      'owner-1',
      { include_recoverable_items: true },
      read_folder,
    );

    // A mailbox with no dumpster is a normal answer, not a failed backup.
    expect(folders.map((f) => f.display_name)).toEqual(['Inbox']);
  });
});
