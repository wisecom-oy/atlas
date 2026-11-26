/**
 * The mailbox existence check that opens an Outlook backup, restore or status run (issue #862).
 *
 * One `404 Request_ResourceNotFound` on `GET /users/{id}?$select=id` used to answer "does not
 * exist", so the run ended with exit `7` for a mailbox the identity registry had just resolved.
 * The 404 is now read again, twice, before the check answers false.
 */

import 'reflect-metadata';
import type { Client } from '@microsoft/microsoft-graph-client';
import { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH_CLIENT_TOKEN, MissingGraphPermissionsError } from '@wisecom/atlas-m365-graph';
import { NotFoundError } from '@wisecom/atlas-types';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';

const OWNER = '00000000-0000-0000-0000-00000000abcd';
const USER = `/users/${OWNER}?$select=id`;

/** A connector whose nth existence read is answered by `answer(n)`. */
function connector_for(answer: (read: number) => unknown) {
  let reads = 0;
  const graph = stub_graph_client(() => answer(++reads));
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph.client as unknown as Client);
  container.bind(GraphMailboxConnector).toSelf();
  return { connector: container.get(GraphMailboxConnector), calls: graph.calls };
}

/** Settles `promise`, advancing fake time through the confirmation waits. */
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

describe('GraphMailboxConnector.mailbox_exists', () => {
  it('answers true when one 404 is followed by a 200', async () => {
    const { connector, calls } = connector_for((read) => {
      if (read === 1) throw graph_error(404, 'Request_ResourceNotFound');
      return { id: OWNER };
    });

    await expect(settle(connector.mailbox_exists('tenant-1', OWNER))).resolves.toBe(true);
    expect(calls.map((call) => call.url)).toEqual([USER, USER]);
  });

  it('answers false for a mailbox that answers 404 on every read, after two extra reads', async () => {
    const { connector, calls } = connector_for(() => {
      throw graph_error(404, 'Request_ResourceNotFound');
    });

    await expect(settle(connector.mailbox_exists('tenant-1', OWNER))).resolves.toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('lets assert_mailbox_exists report a mailbox that is really gone as NotFoundError', async () => {
    const { connector } = connector_for(() => {
      throw graph_error(404, 'Request_ResourceNotFound');
    });

    const outcome = (await settle(assert_mailbox_exists(connector, 'tenant-1', OWNER))) as {
      error: unknown;
    };

    expect(outcome.error).toBeInstanceOf(NotFoundError);
    expect((outcome.error as Error).message).toContain('does not exist in the tenant');
  });

  it('still reports a 403 for a missing grant on the first read', async () => {
    const { connector, calls } = connector_for(() => {
      throw graph_error(403, 'Authorization_RequestDenied');
    });

    const outcome = (await settle(connector.mailbox_exists('tenant-1', OWNER))) as {
      error: unknown;
    };

    expect(outcome.error).toBeInstanceOf(MissingGraphPermissionsError);
    expect(calls).toHaveLength(1);
  });
});
