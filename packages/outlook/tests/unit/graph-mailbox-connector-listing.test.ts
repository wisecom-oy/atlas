import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './graph-mailbox-connector.harness';
import { create_mock_client, create_connector } from './graph-mailbox-connector.harness';

describe('GraphMailboxConnector - listing APIs', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  describe('list_mailboxes', () => {
    it('returns user IDs from a single page', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'user-1', mail: 'a@test.com', displayName: 'User A' },
          { id: 'user-2', mail: 'b@test.com', displayName: 'User B' },
        ],
      });

      const result = await connector.list_mailboxes('tenant-1');
      expect(result).toEqual(['user-1', 'user-2']);
    });

    it('paginates through multiple pages via @odata.nextLink', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'user-1', mail: 'a@test.com' }],
          '@odata.nextLink': '/users?$skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'user-2', mail: 'b@test.com' }],
        });

      const result = await connector.list_mailboxes('tenant-1');

      expect(result).toEqual(['user-1', 'user-2']);
      expect(mock_client.api).toHaveBeenCalledTimes(2);
    });

    it('skips users without an id', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [{ id: 'user-1', mail: 'a@test.com' }, { mail: 'no-id@test.com' }],
      });

      const result = await connector.list_mailboxes('tenant-1');
      expect(result).toEqual(['user-1']);
    });
  });

  describe('list_mail_folders', () => {
    it('returns folders excluding system folders', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'f-inbox', displayName: 'Inbox', parentFolderId: 'root', totalItemCount: 42 },
          { id: 'f-sent', displayName: 'Sent Items', parentFolderId: 'root', totalItemCount: 10 },
          { id: 'f-drafts', displayName: 'Drafts', parentFolderId: 'root', totalItemCount: 3 },
          { id: 'f-outbox', displayName: 'Outbox', parentFolderId: 'root', totalItemCount: 0 },
          { id: 'f-junk', displayName: 'JunkEmail', parentFolderId: 'root', totalItemCount: 5 },
          { id: 'f-recover', displayName: 'RecoverableItemsDeletions', totalItemCount: 1 },
        ],
      });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');

      const names = result.map((f) => f.display_name);
      expect(names).toEqual(['Inbox', 'Sent Items']);
      expect(result[0]).toEqual({
        folder_id: 'f-inbox',
        display_name: 'Inbox',
        folder_path: 'Inbox',
        parent_folder_id: 'root',
        total_item_count: 42,
      });
    });

    it('paginates through folder pages', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'f-1', displayName: 'Inbox' }],
          '@odata.nextLink': '/next',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'f-2', displayName: 'Archive' }],
        });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');
      expect(result).toHaveLength(2);
    });

    it('descends into child folders and reports their full path', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'f-inbox', displayName: 'Inbox', totalItemCount: 1, childFolderCount: 1 }],
        })
        .mockResolvedValueOnce({
          value: [
            {
              id: 'f-projects',
              displayName: 'Projects',
              parentFolderId: 'f-inbox',
              totalItemCount: 2,
              childFolderCount: 1,
            },
          ],
        })
        .mockResolvedValueOnce({
          value: [
            {
              id: 'f-2026',
              displayName: '2026',
              parentFolderId: 'f-projects',
              totalItemCount: 3,
            },
          ],
        });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');

      expect(result.map((f) => f.folder_path)).toEqual([
        'Inbox',
        'Inbox/Projects',
        'Inbox/Projects/2026',
      ]);
      expect(mock_client.api).toHaveBeenCalledWith(
        expect.stringContaining('/mailFolders/f-inbox/childFolders'),
      );
    });

    it('does not request children for leaf folders', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [{ id: 'f-inbox', displayName: 'Inbox', childFolderCount: 0 }],
      });

      await connector.list_mail_folders('tenant-1', 'user-1');

      expect(mock_client.api).toHaveBeenCalledTimes(1);
    });

    it('prunes the subtree of an excluded folder', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [{ id: 'f-junk', displayName: 'JunkEmail', childFolderCount: 2 }],
      });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');

      expect(result).toEqual([]);
      expect(mock_client.api).toHaveBeenCalledTimes(1);
    });
  });
});
