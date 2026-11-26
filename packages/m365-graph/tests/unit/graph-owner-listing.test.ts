/**
 * An owner's existence check and first listing under the in-run confirmation rule.
 *
 * A listing that answers 404 on every read is put down to the owner's absence only when the
 * owner's directory record answers 404 on every read too; otherwise Graph is reported unavailable,
 * so the run ends with the retryable exit `3` rather than exit `7` (issues #862, #863, #864).
 */

import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError, NotFoundError } from '@wisecom/atlas-types';
import {
  graph_error,
  stub_graph_client,
  type GraphCall,
} from '@wisecom/atlas-types/testing/stub-graph-client';
import { read_owner_listing, read_user_exists } from '@/graph-owner-listing';

const OWNER = '00000000-0000-0000-0000-00000000abcd';
const USER_URL = `/users/${OWNER}?$select=id`;
const LISTING_URL = `/users/${OWNER}/calendars`;

/** A Graph client stub, with the urls of every call it answered. */
function client_for(route: (call: GraphCall, count: number) => unknown) {
  const counts = new Map<string, number>();
  const graph = stub_graph_client((call) => {
    const count = (counts.get(call.url) ?? 0) + 1;
    counts.set(call.url, count);
    return route(call, count);
  });
  const urls = (): string[] => graph.calls.map((call) => call.url);
  return { client: graph.client as unknown as Client, urls };
}

/** Lists through the stub, the way a workload's first listing does. */
function list(client: Client, is_conclusive?: (err: unknown) => boolean): Promise<unknown> {
  return read_owner_listing(
    client,
    { owner_id: OWNER, listing: 'calendars', ...(is_conclusive ? { is_conclusive } : {}) },
    () => client.api(LISTING_URL).get() as Promise<unknown>,
  );
}

/** Runs to completion, advancing fake time through every wait. */
async function settle<T>(promise: Promise<T>): Promise<T | { error: unknown }> {
  const settled = promise.catch((error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('read_user_exists', () => {
  it('answers true when a 404 clears on the next read', async () => {
    const { client, urls } = client_for((_call, count) => {
      if (count === 1) throw graph_error(404, 'Request_ResourceNotFound');
      return { id: OWNER };
    });

    await expect(settle(read_user_exists(client, OWNER))).resolves.toBe(true);
    expect(urls()).toEqual([USER_URL, USER_URL]);
  });

  it('answers false only after three reads all answered 404', async () => {
    const { client, urls } = client_for(() => {
      throw graph_error(404, 'Request_ResourceNotFound');
    });

    await expect(settle(read_user_exists(client, OWNER))).resolves.toBe(false);
    expect(urls()).toHaveLength(3);
  });

  it('throws a 403 at once for the caller to classify', async () => {
    const denied = graph_error(403, 'Authorization_RequestDenied');
    const { client, urls } = client_for(() => {
      throw denied;
    });

    await expect(settle(read_user_exists(client, OWNER))).resolves.toEqual({ error: denied });
    expect(urls()).toHaveLength(1);
  });
});

describe('read_owner_listing', () => {
  it('returns the listing when one 404 clears on the next read', async () => {
    const { client, urls } = client_for((_call, count) => {
      if (count === 1) throw graph_error(404, 'ErrorItemNotFound');
      return { value: [] };
    });

    await expect(settle(list(client))).resolves.toEqual({ value: [] });
    expect(urls()).toEqual([LISTING_URL, LISTING_URL]);
  });

  it('reports NotFoundError when the listing and the user both answer 404 on every read', async () => {
    const { client, urls } = client_for(() => {
      throw graph_error(404, 'ErrorItemNotFound');
    });

    const outcome = (await settle(list(client))) as { error: unknown };

    expect(outcome.error).toBeInstanceOf(NotFoundError);
    expect((outcome.error as Error).message).toContain(OWNER);
    // Bounded: three listing reads, then three reads of the user.
    expect(urls()).toEqual([...Array(3).fill(LISTING_URL), ...Array(3).fill(USER_URL)]);
  });

  it('reports Graph unavailable when the listing keeps answering 404 for a user that exists', async () => {
    const { client } = client_for((call) => {
      if (call.url === USER_URL) return { id: OWNER };
      throw graph_error(404, 'itemNotFound');
    });

    const outcome = (await settle(list(client))) as { error: unknown };

    expect(outcome.error).toBeInstanceOf(GraphUnavailableError);
    expect(outcome.error).toMatchObject({ status_code: 404, graph_code: 'itemNotFound' });
  });

  it('reports Graph unavailable when the user check itself is refused', async () => {
    const { client } = client_for((call) => {
      if (call.url === USER_URL) throw graph_error(403, 'Authorization_RequestDenied');
      throw graph_error(404, 'itemNotFound');
    });

    const outcome = (await settle(list(client))) as { error: unknown };

    expect(outcome.error).toBeInstanceOf(GraphUnavailableError);
  });

  it('passes a conclusive 404 back at once, without checking the user', async () => {
    const no_drive = graph_error(404, 'ResourceNotFound', "User's mysite not found.");
    const { client, urls } = client_for(() => {
      throw no_drive;
    });

    const outcome = await settle(list(client, (err) => err === no_drive));

    expect(outcome).toEqual({ error: no_drive });
    expect(urls()).toEqual([LISTING_URL]);
  });

  it('classifies a 400 that persists as GraphUnavailableError without checking the user', async () => {
    const { client, urls } = client_for(() => {
      throw graph_error(400, 'invalidRequest');
    });

    const outcome = (await settle(list(client))) as { error: unknown };

    expect(outcome.error).toBeInstanceOf(GraphUnavailableError);
    expect(urls()).toEqual(Array(3).fill(LISTING_URL));
  });
});
