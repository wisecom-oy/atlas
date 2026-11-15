import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import { GraphMailboxDiscoveryAdapter } from '@/adapters/graph-mailbox-discovery.adapter';
import { create_folder_reader, list_mail_folder_tree } from '@/adapters/graph-mail-folder-listing';

/**
 * Issue #773: a best-effort lookup may swallow a 403 or 404, but not an exhausted retry budget.
 * Swallowing it let the next call spend a second full budget on the same outage, so one backup
 * attempt took about 57 minutes instead of 24.
 */

// The retry loop is not under test: each call runs once and rejects with what the stub throws.
vi.mock('@wisecom/atlas-m365-graph', async (import_original) => {
  const actual = await import_original<Record<string, unknown>>();
  return { ...actual, with_graph_retry: (fn: () => unknown) => fn() };
});

const UNAVAILABLE = new GraphUnavailableError(
  'Microsoft Graph was unavailable after 12 retries over 1412 s: HTTP 504 -- UnknownError',
  { retries: 12, elapsed_ms: 1_412_000 },
  { status_code: 504 },
);
const FORBIDDEN = Object.assign(new Error('Access is denied'), { statusCode: 403 });

/** A Graph client whose every request rejects with `err`. */
function client_failing_with(err: unknown): { client: Client; api: ReturnType<typeof vi.fn> } {
  const api = vi.fn(() => {
    const chain = { header: () => chain, get: () => Promise.reject(err) };
    return chain;
  });
  return { client: { api } as unknown as Client, api };
}

describe('GraphMailboxConnector.get_mailbox_purpose', () => {
  it('still resolves undefined when Graph refuses the lookup with 403', async () => {
    const connector = new GraphMailboxConnector(client_failing_with(FORBIDDEN).client);

    await expect(connector.get_mailbox_purpose('t', 'owner-1')).resolves.toBeUndefined();
  });

  it.each([
    ['GraphUnavailableError', UNAVAILABLE],
    ['ThrottledError', new ThrottledError('throttled after 12 retries', 1000)],
  ])('rethrows an exhausted budget (%s) instead of swallowing it', async (_, err) => {
    const connector = new GraphMailboxConnector(client_failing_with(err).client);

    await expect(connector.get_mailbox_purpose('t', 'owner-1')).rejects.toBe(err);
  });
});

describe('list_mail_folder_tree well-known role lookup', () => {
  it('fails the listing on an exhausted budget rather than leaving roles untagged', async () => {
    const get_one = vi.fn(() => Promise.reject(UNAVAILABLE));

    await expect(
      list_mail_folder_tree(
        async () => [{ id: 'f-1', displayName: 'Inbox' }],
        'owner-1',
        {},
        create_folder_reader(get_one, 'owner-1'),
      ),
    ).rejects.toBe(UNAVAILABLE);
    expect(get_one).toHaveBeenCalledOnce();
  });
});

describe('GraphMailboxDiscoveryAdapter userPurpose lookup', () => {
  it('fails discovery on an exhausted budget and stops asking for the other users', async () => {
    const users = Array.from({ length: 20 }, (_, i) => ({
      id: `u${i}`,
      mail: `user${i}@example.com`,
      displayName: `User ${i}`,
    }));
    const settings_calls: string[] = [];
    const api = vi.fn((url: string) => {
      const chain = {
        header: () => chain,
        get: async () => {
          if (url.startsWith('/users?')) return { value: users };
          if (url.includes('mailboxSettings')) {
            settings_calls.push(url);
            throw UNAVAILABLE;
          }
          throw new Error('no Reports.Read.All');
        },
      };
      return chain;
    });
    const container = new Container();
    container.bind(GRAPH_CLIENT_TOKEN).toConstantValue({ api });
    container.bind(GraphMailboxDiscoveryAdapter).toSelf();

    await expect(
      container.get(GraphMailboxDiscoveryAdapter).list_tenant_mailboxes('t1'),
    ).rejects.toBe(UNAVAILABLE);
    // Each of the five workers asks once at most; the other users are never looked up.
    expect(settings_calls.length).toBeLessThanOrEqual(5);
  });
});
