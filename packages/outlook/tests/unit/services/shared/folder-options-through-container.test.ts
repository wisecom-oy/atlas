import { describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import { MAILBOX_CONNECTOR_TOKEN, THROTTLE_COORDINATOR_TOKEN } from '@wisecom/atlas-types';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import type { MailboxConnector } from '@wisecom/atlas-types';
import { bind_outlook } from '@/container';
import { resolve_backup_folders } from '@/services/shared/folder-selector';

/**
 * Issue #455. The folder options were dropped by the rate-limiting decorator, the only connector
 * bound to MAILBOX_CONNECTOR_TOKEN. Earlier tests called GraphMailboxConnector directly or mocked
 * the port, so none of them went through the decorator. This resolves the connector the way the
 * CLI and SDK do and runs the backup folder selection against a Graph stub.
 */

const OWNER = 'john.doe@example.com';

/** Graph answers keyed by request path, ignoring the query string. */
const ROUTES: Record<string, unknown> = {
  [`/users/${OWNER}/mailFolders`]: {
    value: [
      { id: 'f-inbox', displayName: 'Inbox', parentFolderId: 'root', totalItemCount: 4 },
      { id: 'f-junk', displayName: 'Junk Email', parentFolderId: 'root', totalItemCount: 2 },
      {
        id: 'f-cas',
        displayName: 'Conversation Action Settings',
        parentFolderId: 'root',
        isHidden: true,
      },
    ],
  },
  [`/users/${OWNER}/mailFolders/recoverableitemsdeletions`]: {
    id: 'f-deletions',
    displayName: 'Deletions',
    parentFolderId: 'f-rir',
  },
  [`/users/${OWNER}/mailFolders/f-rir/childFolders`]: {
    value: [
      { id: 'f-deletions', displayName: 'Deletions', parentFolderId: 'f-rir', totalItemCount: 3 },
      { id: 'f-purges', displayName: 'Purges', parentFolderId: 'f-rir', totalItemCount: 1 },
    ],
  },
};

function make_graph_client() {
  return {
    api: vi.fn((url: string) => {
      const chain = {
        header: () => chain,
        get: async () => {
          const body = ROUTES[url.split('?')[0]!];
          // Other well-known folder reads: the mailbox has no such folder.
          if (body === undefined) throw Object.assign(new Error('Not found'), { statusCode: 404 });
          return body;
        },
      };
      return chain;
    }),
  };
}

function resolve_bound_connector(): MailboxConnector {
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(make_graph_client());
  // bind_graph_client binds this in the CLI and SDK containers.
  container.bind(THROTTLE_COORDINATOR_TOKEN).toConstantValue(new InProcessThrottleCoordinator());
  bind_outlook(container);
  return container.get<MailboxConnector>(MAILBOX_CONNECTOR_TOKEN);
}

describe('backup folder options through the container-bound connector', () => {
  it('captures Recoverable Items when include_recoverable_items is set', async () => {
    const { folders } = await resolve_backup_folders(resolve_bound_connector(), 't', OWNER, {
      include_recoverable_items: true,
    });

    expect(folders.filter((f) => f.is_recoverable_items).map((f) => f.display_name)).toEqual([
      'Deletions',
      'Purges',
    ]);
  });

  it('omits Junk Email when exclude_junk is set, and records why', async () => {
    const { folders, excluded } = await resolve_backup_folders(
      resolve_bound_connector(),
      't',
      OWNER,
      { exclude_junk: true },
    );

    expect(folders.map((f) => f.display_name)).not.toContain('Junk Email');
    expect(excluded).toContainEqual(expect.objectContaining({ reason: 'junk-excluded' }));
  });

  it('records a pruned hidden system folder for the manifest', async () => {
    const { excluded } = await resolve_backup_folders(resolve_bound_connector(), 't', OWNER, {});

    expect(excluded).toContainEqual(expect.objectContaining({ reason: 'hidden-system-folder' }));
  });
});
