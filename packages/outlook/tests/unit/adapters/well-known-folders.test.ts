import { describe, expect, it, vi } from 'vitest';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { create_folder_reader, list_mail_folder_tree } from '@/adapters/graph-mail-folder-listing';

const NOT_FOUND = Object.assign(new Error('ErrorFolderNotFound'), { statusCode: 404 });

/** A Graph GET that resolves the given well-known names and 404s every other folder read. */
function make_get_one(ids_by_name: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const name = /\/mailFolders\/([^?]+)\?/.exec(url)?.[1] ?? '';
    const id = ids_by_name[name];
    if (!id) throw NOT_FOUND;
    return { id };
  });
}

function folders(count: number): GraphFolderRecord[] {
  return Array.from({ length: count }, (_, i) => ({ id: `f-${i}`, displayName: `Folder ${i}` }));
}

describe('list_mail_folder_tree well-known folder roles', () => {
  it('tags a localized mailbox by folder id, not display name', async () => {
    const listed: GraphFolderRecord[] = [
      { id: 'f-saapuneet', displayName: 'Saapuneet' },
      { id: 'f-lahetetyt', displayName: 'Lähetetyt' },
      { id: 'f-user-archive', displayName: 'Archive' },
    ];
    const get_one = make_get_one({ inbox: 'f-saapuneet', sentitems: 'f-lahetetyt' });

    const result = await list_mail_folder_tree(
      async () => listed,
      'owner-1',
      {},
      create_folder_reader(get_one, 'owner-1'),
    );

    expect(result.map((f) => [f.display_name, f.well_known_name])).toEqual([
      ['Saapuneet', 'inbox'],
      ['Lähetetyt', 'sentitems'],
      // The mailbox has no archive folder (404); a user folder named Archive is not it.
      ['Archive', undefined],
    ]);
    expect(result[2]).not.toHaveProperty('well_known_name');
  });

  it('spends the same number of lookups whatever the folder count', async () => {
    const small = make_get_one({});
    const large = make_get_one({});

    await list_mail_folder_tree(async () => folders(1), 'o', {}, create_folder_reader(small, 'o'));
    await list_mail_folder_tree(async () => folders(80), 'o', {}, create_folder_reader(large, 'o'));

    expect(small.mock.calls.length).toBeGreaterThan(0);
    expect(large).toHaveBeenCalledTimes(small.mock.calls.length);
  });

  it('keeps the listing when a lookup fails with something other than 404', async () => {
    const get_one = vi.fn(async (url: string) => {
      if (url.includes('/mailFolders/inbox?')) return { id: 'f-0' };
      throw Object.assign(new Error('ErrorInvalidRequest'), { statusCode: 400 });
    });

    const result = await list_mail_folder_tree(
      async () => folders(2),
      'o',
      {},
      create_folder_reader(get_one, 'o'),
    );

    expect(result.map((f) => f.well_known_name)).toEqual(['inbox', undefined]);
  });
});
