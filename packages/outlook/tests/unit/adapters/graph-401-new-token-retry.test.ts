/**
 * Issue #861: a Graph `401` on a freshly issued token failed the mailbox check before any item, and
 * failed a folder when it hit a delta page. `with_graph_retry` now repeats a `401` once with a new
 * token, so a single one no longer costs the run or the folder.
 */
import 'reflect-metadata';
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import { fetch_mail_continuation_page } from '@/adapters/graph-mail-delta-sync';
import { GraphRestoreConnector } from '@/adapters/graph-restore-connector.adapter';

const OWNER = 'user@example.com';
const PAGE_URL =
  'https://graph.microsoft.com/v1.0/users/u/mailFolders/f/messages/delta?$skiptoken=1';

/** Graph answering the first request with a `401` carrying `code`, and every later one with `body`. */
function graph_rejecting_first_token(body: unknown, code = 'InvalidAuthenticationToken') {
  let requests = 0;
  return stub_graph_client(() => {
    requests++;
    if (requests === 1) throw graph_error(401, code);
    return body;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a single Graph 401 before any item', () => {
  it('still finds the mailbox', async () => {
    const graph = graph_rejecting_first_token({ id: 'owner-id' });
    const connector = new GraphMailboxConnector(graph.client as unknown as Client);

    const exists = connector.mailbox_exists('t', 'owner-id');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(exists).resolves.toBe(true);
    expect(graph.calls).toHaveLength(2);
  });

  it('reports a 401 that persists after the new token', async () => {
    const graph = stub_graph_client(() => {
      throw graph_error(401, 'InvalidAuthenticationToken');
    });
    const connector = new GraphMailboxConnector(graph.client as unknown as Client);

    const exists = connector.mailbox_exists('t', 'owner-id').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await exists).toMatchObject({ statusCode: 401 });
    expect(graph.calls).toHaveLength(2);
  });
});

describe('a single Graph 401 on a delta page', () => {
  it('returns the page instead of failing the folder', async () => {
    const page = { value: [], '@odata.deltaLink': 'delta-link' };
    const graph = graph_rejecting_first_token(page);

    const result = fetch_mail_continuation_page(graph.client as unknown as Client, PAGE_URL, 100);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual(page);
  });
});

describe('a Graph 401 on a restore write', () => {
  it('sends the message again when Graph rejected the token before processing it', async () => {
    const graph = graph_rejecting_first_token({ id: 'msg-1' });
    const connector = new GraphRestoreConnector(graph.client as unknown as Client);

    const created = connector.create_message('t', OWNER, 'folder-1', { subject: 's' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(created).resolves.toBe('msg-1');
    expect(graph.calls.filter((call) => call.method === 'post')).toHaveLength(2);
  });

  it('sends the message once on a 401 that does not prove it was never processed', async () => {
    const graph = graph_rejecting_first_token({ id: 'msg-1' }, 'Unauthorized');
    const connector = new GraphRestoreConnector(graph.client as unknown as Client);

    const created = connector
      .create_message('t', OWNER, 'folder-1', { subject: 's' })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await created).toMatchObject({ statusCode: 401 });
    expect(graph.calls.filter((call) => call.method === 'post')).toHaveLength(1);
  });
});
