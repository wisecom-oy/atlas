import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './mailbox-connector.fixtures';
import { create_mock_client, create_connector } from './mailbox-connector.fixtures';

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

    it('resumes a failed page from its nextLink instead of restarting from page 1 (issue #33)', async () => {
      vi.useFakeTimers();
      try {
        mock_client._chain.get
          .mockResolvedValueOnce({
            value: [{ id: 'user-1', mail: 'a@test.com' }],
            '@odata.nextLink': '/users?$skiptoken=page2',
          })
          .mockRejectedValueOnce(
            Object.assign(new Error('service unavailable'), { statusCode: 503 }),
          )
          .mockResolvedValueOnce({
            value: [{ id: 'user-2', mail: 'b@test.com' }],
          });

        const promise = connector.list_mailboxes('tenant-1');
        await vi.advanceTimersByTimeAsync(5_000); // skip the retry backoff
        const result = await promise;

        expect(result).toEqual(['user-1', 'user-2']);
        const urls = mock_client.api.mock.calls.map((c) => c[0] as string);
        // Page 1 fetched exactly once: the 503 retried only page 2.
        expect(urls.filter((u) => !u.includes('skiptoken')).length).toBe(1);
        expect(urls.filter((u) => u.includes('skiptoken')).length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('completes an enumeration whose total time exceeds the per-request timeout (issue #33 acceptance)', async () => {
      vi.useFakeTimers();
      try {
        const slow_page =
          (body: Record<string, unknown>) => (): Promise<Record<string, unknown>> => {
            const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
            setTimeout(() => resolve(body), 40_000); // each page slower than nothing, total 120s > 60s window
            return promise;
          };
        mock_client._chain.get
          .mockImplementationOnce(
            slow_page({
              value: [{ id: 'u1', mail: 'a@t.com' }],
              '@odata.nextLink': '/users?$skiptoken=p2',
            }),
          )
          .mockImplementationOnce(
            slow_page({
              value: [{ id: 'u2', mail: 'b@t.com' }],
              '@odata.nextLink': '/users?$skiptoken=p3',
            }),
          )
          .mockImplementationOnce(slow_page({ value: [{ id: 'u3', mail: 'c@t.com' }] }));

        const promise = connector.list_mailboxes('tenant-1');
        await vi.advanceTimersByTimeAsync(120_000);
        const result = await promise;

        expect(result).toEqual(['u1', 'u2', 'u3']);
        // Exactly one fetch per page: no whole-enumeration timeout restarted paging.
        expect(mock_client.api).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('list_mail_folders', () => {
    it('returns every mail-bearing folder, including Drafts, Outbox and Junk', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'f-inbox', displayName: 'Inbox', parentFolderId: 'root', totalItemCount: 42 },
          { id: 'f-sent', displayName: 'Sent Items', parentFolderId: 'root', totalItemCount: 10 },
          { id: 'f-drafts', displayName: 'Drafts', parentFolderId: 'root', totalItemCount: 3 },
          { id: 'f-outbox', displayName: 'Outbox', parentFolderId: 'root', totalItemCount: 0 },
          { id: 'f-junk', displayName: 'Junk Email', parentFolderId: 'root', totalItemCount: 5 },
        ],
      });

      const result = await connector.list_mail_folders('tenant-1', 'user-1');

      const names = result.map((f) => f.display_name);
      expect(names).toEqual(['Inbox', 'Sent Items', 'Drafts', 'Outbox', 'Junk Email']);
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

    it('prunes the subtree of a folder the caller excluded', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [{ id: 'f-junk', displayName: 'Junk Email', childFolderCount: 2 }],
      });

      const result = await connector.list_mail_folders('tenant-1', 'user-1', {
        exclude_junk: true,
      });

      expect(result).toEqual([]);
      expect(mock_client.api).toHaveBeenCalledTimes(1);
    });

    it('asks Graph for hidden folders, which it omits by default', async () => {
      mock_client._chain.get.mockResolvedValueOnce({ value: [] });

      await connector.list_mail_folders('tenant-1', 'user-1');

      const url = mock_client.api.mock.calls[0]?.[0] as string;
      expect(url).toContain('includeHiddenFolders=true');
      expect(url).toContain('isHidden');
    });
  });
});
