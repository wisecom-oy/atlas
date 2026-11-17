/**
 * Issue #624: Graph can commit a create and still answer 5xx, or answer after the attempt timed
 * out. Sending the POST again put a second copy of the message in the restore folder.
 */
import 'reflect-metadata';
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { GraphRestoreConnector } from '@/adapters/graph-restore-connector.adapter';

const OWNER = 'user@example.com';

/** A mailbox that stores every posted message, then fails the first response the way `respond` does. */
function committing_mailbox(respond: (posted: number) => unknown) {
  const stored: unknown[] = [];
  const graph = stub_graph_client((call) => {
    if (call.method !== 'post') return {};
    stored.push(call.body);
    return respond(stored.length);
  });
  const connector = new GraphRestoreConnector(graph.client as unknown as Client);
  return { connector, stored };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GraphRestoreConnector create_message after an ambiguous failure', () => {
  it('reports a 503 that followed the commit instead of creating the message again', async () => {
    const { connector, stored } = committing_mailbox((posted) => {
      if (posted === 1) throw graph_error(503, 'ServiceUnavailable');
      return { id: `msg-${posted}` };
    });

    const outcome = connector
      .create_message('t', OWNER, 'folder-1', { subject: 'Marker' })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ statusCode: 503 });
    expect(stored).toHaveLength(1);
  });

  it('reports a timed-out create instead of creating the message again', async () => {
    const { connector, stored } = committing_mailbox((posted) =>
      posted === 1 ? Promise.withResolvers<unknown>().promise : { id: `msg-${posted}` },
    );

    const outcome = connector
      .create_message('t', OWNER, 'folder-1', { subject: 'Marker' })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' });
    expect(stored).toHaveLength(1);
  });

  it('still retries a 429, which Graph answers without creating anything', async () => {
    const stored: unknown[] = [];
    let attempts = 0;
    const graph = stub_graph_client(() => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(graph_error(429, 'TooManyRequests'), {
          headers: { 'retry-after': '1' },
        });
      }
      stored.push('created');
      return { id: 'msg-1' };
    });
    const connector = new GraphRestoreConnector(graph.client as unknown as Client);

    const outcome = connector.create_message('t', OWNER, 'folder-1', { subject: 'Marker' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toBe('msg-1');
    expect(stored).toHaveLength(1);
  });

  it('sends a small attachment once when Graph answers 502 after storing it', async () => {
    const { connector, stored } = committing_mailbox(() => {
      throw graph_error(502, 'BadGateway');
    });

    const outcome = connector
      .add_attachment('t', OWNER, 'msg-1', {
        name: 'note.txt',
        content_type: 'text/plain',
        content: Buffer.from('hello'),
        is_inline: false,
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ statusCode: 502 });
    expect(stored).toHaveLength(1);
  });
});
