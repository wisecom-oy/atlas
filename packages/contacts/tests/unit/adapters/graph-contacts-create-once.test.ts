/**
 * Issue #624: Graph can commit a create and still answer 5xx, or answer after the attempt timed
 * out. Restore dedupes only against contacts present before its loop began, so a resent POST left
 * two copies of the contact.
 */
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { create_contact } from '@/adapters/graph-contacts-items';
import { create_contact_folder } from '@/adapters/graph-contacts-folders';

const MAILBOX = 'user@example.com';

/** A contacts store that keeps every POST, then answers the way `respond` does. */
function committing_contacts(respond: (posted: number) => unknown) {
  const stored: unknown[] = [];
  const graph = stub_graph_client((call) => {
    stored.push(call.body);
    return respond(stored.length);
  });
  return { client: graph.client as unknown as Client, stored };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('create_contact after an ambiguous failure', () => {
  it('reports a 503 that followed the commit instead of posting the contact again', async () => {
    const { client, stored } = committing_contacts((posted) => {
      if (posted === 1) throw graph_error(503, 'ServiceUnavailable');
      return { id: `contact-${posted}` };
    });

    const outcome = create_contact(client, MAILBOX, 'folder-1', { displayName: 'Marker' }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ statusCode: 503 });
    expect(stored).toHaveLength(1);
  });

  it('reports a timed-out create instead of posting the contact again', async () => {
    const { client, stored } = committing_contacts((posted) =>
      posted === 1 ? Promise.withResolvers<unknown>().promise : { id: `contact-${posted}` },
    );

    const outcome = create_contact(client, MAILBOX, 'folder-1', { displayName: 'Marker' }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' });
    expect(stored).toHaveLength(1);
  });
});

describe('create_contact_folder after an ambiguous failure', () => {
  it('reports a 500 instead of creating a second folder', async () => {
    const { client, stored } = committing_contacts(() => {
      throw graph_error(500, 'InternalServerError');
    });

    const outcome = create_contact_folder(client, MAILBOX, 'root', 'Restored').catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ statusCode: 500 });
    expect(stored).toHaveLength(1);
  });
});
