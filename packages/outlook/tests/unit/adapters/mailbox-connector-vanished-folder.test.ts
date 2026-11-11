import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { ExcludedFolder } from '@wisecom/atlas-types';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './mailbox-connector.fixtures';
import { create_mock_client, create_connector } from './mailbox-connector.fixtures';

const NOT_FOUND = Object.assign(new Error('The specified object was not found in the store.'), {
  statusCode: 404,
  code: 'ErrorItemNotFound',
});

/** Answers each Graph GET by the URL last passed to `api`. */
function route_by_url(client: MockClient, respond: (url: string) => unknown): void {
  let last_url = '';
  client.api.mockImplementation((url: string) => {
    last_url = url;
    return client._chain;
  });
  client._chain.get.mockImplementation(async () => respond(last_url));
}

describe('GraphMailboxConnector - folder deleted while folders are listed (issue #690)', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('lists the rest of the mailbox when a childFolders request answers 404', async () => {
    route_by_url(mock_client, (url) => {
      if (url.includes('/mailFolders/f-gone/childFolders')) throw NOT_FOUND;
      if (url.includes('/mailFolders?')) {
        return {
          value: [
            { id: 'f-inbox', displayName: 'Inbox' },
            { id: 'f-gone', displayName: 'Example Folder', childFolderCount: 1 },
          ],
        };
      }
      throw NOT_FOUND; // well-known folder reads: not this mailbox's concern here
    });
    const excluded: ExcludedFolder[] = [];

    const folders = await connector.list_mail_folders('tenant-1', 'user-1', {
      on_excluded: (folder) => excluded.push(folder),
    });

    expect(folders.map((f) => f.folder_path)).toEqual(['Inbox']);
    expect(excluded).toEqual([{ folder_path: 'Example Folder', reason: 'deleted-during-listing' }]);
  });

  it('fails when the root mailFolders listing answers 404', async () => {
    route_by_url(mock_client, () => {
      throw NOT_FOUND;
    });

    await expect(connector.list_mail_folders('tenant-1', 'user-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
