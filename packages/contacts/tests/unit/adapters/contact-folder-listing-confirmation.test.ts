/**
 * The contact folder listing that opens a Contacts backup, under the in-run confirmation rule
 * (#864).
 *
 * `GET /users/{id}/contactFolders/contacts` and its `childFolders` listings were sent once. A
 * transient 404 ended the run with exit `7` and a transient 400 with an unclassified exit `1`. The
 * whole listing is read again now; a 404 that persists is `NotFoundError` only when the mailbox's
 * user answers 404 too, and every other persistent 4xx is `GraphUnavailableError`. Licence and
 * missing-grant answers keep their errors and are not repeated.
 */

import 'reflect-metadata';

import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import {
  GraphUnavailableError,
  MailboxNotLicensedError,
  NotFoundError,
} from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';

import { list_contact_folders } from '@/adapters/graph-contacts-folders';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const BASE = `/users/${MAILBOX}/contactFolders`;
const ROOT = `${BASE}/contacts`;
const CHILDREN = `${BASE}/root/childFolders?$count=true`;
const USER = `/users/${MAILBOX}?$select=id`;

/** Answers the root folder and an empty child listing, unless `fail` throws first. */
function folder_route(fail: (url: string, count: number) => void) {
  const counts = new Map<string, number>();
  const graph = stub_graph_client((call: GraphCall) => {
    const count = (counts.get(call.url) ?? 0) + 1;
    counts.set(call.url, count);
    fail(call.url, count);
    if (call.url === USER) return { id: MAILBOX };
    if (call.url === ROOT) return { id: 'root', displayName: 'Contacts' };
    return { value: [], '@odata.count': 0 };
  });
  const urls = (): string[] => graph.calls.map((call) => call.url);
  return { client: graph.client as unknown as Client, urls };
}

/** Lists the folders, advancing fake time through every wait; a failure comes back as `error`. */
async function list(client: Client): Promise<unknown> {
  const outcome = list_contact_folders(client, MAILBOX).catch((error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('list_contact_folders after a transient answer on the listing', () => {
  it.each([
    [404, 'ErrorItemNotFound'],
    [400, 'invalidRequest'],
  ])('lists the folders when one %i on the root folder clears', async (status, code) => {
    const { client, urls } = folder_route((url, count) => {
      if (url === ROOT && count === 1) throw graph_error(status, code);
    });

    await expect(list(client)).resolves.toEqual([
      { id: 'root', display_name: 'Contacts', path: [] },
    ]);
    expect(urls()).toEqual([ROOT, ROOT, CHILDREN]);
  });

  it('reads the whole listing again after one 404 on a child folder listing', async () => {
    const { client, urls } = folder_route((url, count) => {
      if (url === CHILDREN && count === 1) throw graph_error(404, 'ErrorItemNotFound');
    });

    await expect(list(client)).resolves.toHaveLength(1);
    expect(urls()).toEqual([ROOT, CHILDREN, ROOT, CHILDREN]);
  });

  it('reports a 404 that persists for a mailbox that exists as GraphUnavailableError', async () => {
    const { client } = folder_route((url) => {
      if (url === ROOT) throw graph_error(404, 'ErrorItemNotFound');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(GraphUnavailableError);
  });

  it('reports NotFoundError, within six requests, when the mailbox user is gone too', async () => {
    const { client, urls } = folder_route(() => {
      throw graph_error(404, 'ErrorItemNotFound');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(NotFoundError);
    expect(urls()).toHaveLength(6);
  });

  it('classifies a 400 that persists as GraphUnavailableError rather than an unclassified error', async () => {
    const { client } = folder_route((url) => {
      if (url === ROOT) throw graph_error(400, 'invalidRequest');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(GraphUnavailableError);
    expect(error).toMatchObject({ status_code: 400, graph_code: 'invalidRequest' });
  });

  it('reports a missing grant on the first read', async () => {
    const { client, urls } = folder_route(() => {
      throw graph_error(403, 'ErrorAccessDenied');
    });

    const { error } = (await list(client)) as { error: unknown };

    expect(error).toBeInstanceOf(MissingGraphPermissionsError);
    expect((error as Error).message).toContain('Contacts.Read');
    expect(urls()).toEqual([ROOT]);
  });

  it.each([403, 404])(
    'reports MailboxNotEnabledForRESTAPI on a %i as an unlicensed mailbox, on the first read',
    async (status) => {
      const { client, urls } = folder_route(() => {
        throw graph_error(status, 'MailboxNotEnabledForRESTAPI');
      });

      const { error } = (await list(client)) as { error: unknown };

      expect(error).toBeInstanceOf(MailboxNotLicensedError);
      expect(urls()).toEqual([ROOT]);
    },
  );
});
