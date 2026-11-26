import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { list_mail_folder_tree } from '@/adapters/graph-mail-folder-listing';
import { RECOVERABLE_ITEMS_ANCHOR } from '@/adapters/graph-recoverable-items';
import { create_connector, create_mock_client } from './mailbox-connector.fixtures';

/**
 * Issue #894. A folder Graph listed twice was synced twice, and its subtree walked once per copy.
 */

const OWNER = 'user-1';

/** Fake paged listing: answers each collection URL with the children of the parent it names. */
function fetch_page_from(tree: Record<string, GraphFolderRecord[]>) {
  return vi.fn(async (url: string) => {
    const parent = /mailFolders\/([^/?]+)\/childFolders/.exec(url)?.[1] ?? 'root';
    return tree[parent] ?? [];
  });
}

/** URLs that listed the children of `folder_id`. */
function child_listings(fetch_page: ReturnType<typeof fetch_page_from>, folder_id: string) {
  return fetch_page.mock.calls.filter(([url]) => url.includes(`/${folder_id}/childFolders`));
}

describe('list_mail_folder_tree - a folder listed more than once (issue #894)', () => {
  const inbox: GraphFolderRecord = { id: 'f-inbox', displayName: 'Inbox', childFolderCount: 1 };
  const projects: GraphFolderRecord = {
    id: 'f-projects',
    displayName: 'Projects',
    childFolderCount: 1,
  };
  const archive: GraphFolderRecord = { id: 'f-2026', displayName: '2026' };

  it('returns a folder repeated in one listing once and walks its subtree once', async () => {
    const fetch_page = fetch_page_from({
      root: [inbox, { id: 'f-sent', displayName: 'Sent Items' }, inbox],
      'f-inbox': [projects, projects],
      'f-projects': [archive],
    });

    const folders = await list_mail_folder_tree(fetch_page, OWNER);

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Inbox',
      'Inbox/Projects',
      'Inbox/Projects/2026',
      'Sent Items',
    ]);
    expect(child_listings(fetch_page, 'f-inbox')).toHaveLength(1);
    expect(child_listings(fetch_page, 'f-projects')).toHaveLength(1);
  });

  it('returns a folder listed under two parents once, at the first place it was listed', async () => {
    const fetch_page = fetch_page_from({
      root: [inbox, { id: 'f-archive', displayName: 'Archive', childFolderCount: 1 }],
      'f-inbox': [projects],
      'f-archive': [projects],
      'f-projects': [archive],
    });

    const folders = await list_mail_folder_tree(fetch_page, OWNER);

    expect(folders.map((f) => f.folder_path)).toEqual([
      'Inbox',
      'Inbox/Projects',
      'Inbox/Projects/2026',
      'Archive',
    ]);
    expect(child_listings(fetch_page, 'f-projects')).toHaveLength(1);
  });

  it('returns a repeated Recoverable Items subfolder once', async () => {
    const deletions: GraphFolderRecord = {
      id: 'f-deletions',
      displayName: 'Deletions',
      parentFolderId: 'f-dumpster',
    };
    const fetch_page = fetch_page_from({ root: [], 'f-dumpster': [deletions, deletions] });
    const read_folder = vi.fn(async (ref: string) =>
      ref === RECOVERABLE_ITEMS_ANCHOR ? deletions : undefined,
    );

    const folders = await list_mail_folder_tree(
      fetch_page,
      OWNER,
      { include_recoverable_items: true },
      read_folder,
    );

    expect(folders.map((f) => f.folder_path)).toEqual(['Recoverable Items/Deletions']);
  });
});

describe('GraphMailboxConnector.list_mail_folders - repeats and the listing count (issues #853, #894)', () => {
  it('counts a repeat toward the completeness check, then returns the folder once', async () => {
    const mock_client = create_mock_client();
    mock_client._chain.get
      .mockResolvedValueOnce({
        value: [{ id: 'f-inbox', displayName: 'Inbox' }],
        '@odata.count': 2,
        '@odata.nextLink': '/next',
      })
      .mockResolvedValueOnce({
        value: [{ id: 'f-inbox', displayName: 'Inbox' }],
        '@odata.count': 2,
      });

    const folders = await create_connector(mock_client).list_mail_folders('tenant-1', OWNER);

    expect(folders.map((f) => f.folder_id)).toEqual(['f-inbox']);
  });

  it('still refuses a listing whose items, repeats included, fall short of the count', async () => {
    const mock_client = create_mock_client();
    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        { id: 'f-inbox', displayName: 'Inbox' },
        { id: 'f-inbox', displayName: 'Inbox' },
      ],
      '@odata.count': 3,
    });

    await expect(
      create_connector(mock_client).list_mail_folders('tenant-1', OWNER),
    ).rejects.toMatchObject({
      code: 'ATLAS_LISTING_INCOMPLETE',
      listed_count: 2,
      reported_count: 3,
    });
  });
});
