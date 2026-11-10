/**
 * Issue #624: Graph can commit a create and still answer 5xx, or answer after the attempt timed
 * out. Restore dedupes only against events present before its loop began, so a resent POST left
 * two copies of the event.
 */
import type { Client } from '@microsoft/microsoft-graph-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graph_error, stub_graph_client } from '@wisecom/atlas-types/testing/stub-graph-client';
import { create_event } from '@/adapters/graph-calendar-events';
import { create_calendar } from '@/adapters/graph-calendar-calendars';

const MAILBOX = 'user@example.com';

/** A calendar that stores every POST, then answers the way `respond` does. */
function committing_calendar(respond: (posted: number) => unknown) {
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

describe('create_event after an ambiguous failure', () => {
  it('reports a 503 that followed the commit instead of posting the event again', async () => {
    const { client, stored } = committing_calendar((posted) => {
      if (posted === 1) throw graph_error(503, 'ServiceUnavailable');
      return { id: `event-${posted}` };
    });

    const outcome = create_event(client, MAILBOX, 'cal-1', { subject: 'Marker' }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ statusCode: 503 });
    expect(stored).toHaveLength(1);
  });

  it('reports a timed-out create instead of posting the event again', async () => {
    const { client, stored } = committing_calendar((posted) =>
      posted === 1 ? Promise.withResolvers<unknown>().promise : { id: `event-${posted}` },
    );

    const outcome = create_event(client, MAILBOX, 'cal-1', { subject: 'Marker' }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' });
    expect(stored).toHaveLength(1);
  });
});

describe('create_calendar after an ambiguous failure', () => {
  it('reports a 504 instead of creating a second calendar', async () => {
    const { client, stored } = committing_calendar(() => {
      throw graph_error(504, 'GatewayTimeout');
    });

    const outcome = create_calendar(client, MAILBOX, 'Restored').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ statusCode: 504 });
    expect(stored).toHaveLength(1);
  });
});
