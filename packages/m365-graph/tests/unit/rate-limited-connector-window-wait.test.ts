/**
 * Issue #859. Drives the Outlook connector and its per-mailbox limiter together the way a backup
 * reads messages: the MIME read, then the reaction read, one token each. Once the request window is
 * spent, the next read parks on it with no Graph request in flight. At that point the slide timer is
 * the only thing left that can wake it, so it alone decides whether Node keeps running or exits 0
 * mid-run with nothing committed.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';

const WINDOW_MS = 600_000;
const WINDOW_CAPACITY = 2;
const TENANT = 'tenant-a';
const MAILBOX = 'mailbox-a';

interface FakeTimer {
  hasRef(): boolean;
}

interface StubGraph {
  inner: MailboxConnector;
  in_flight: () => number;
}

let set_interval: MockInstance<typeof setInterval>;
let set_timeout: MockInstance<typeof setTimeout>;
let connector: RateLimitedGraphConnector;
let graph: StubGraph;

/** A connector whose reads answer at once and count how many are in flight. */
function stub_graph(): StubGraph {
  let in_flight = 0;
  const answer = async <T>(value: T): Promise<T> => {
    in_flight++;
    await Promise.resolve();
    in_flight--;
    return value;
  };
  const inner = {
    fetch_mime: () => answer(Buffer.from('mime')),
    fetch_extended_properties: () => answer(new Map()),
  } as unknown as MailboxConnector;
  return { inner, in_flight: () => in_flight };
}

/** Whether any timer the run created still keeps Node from exiting. */
function timers_hold_process(): boolean {
  return [...set_interval.mock.results, ...set_timeout.mock.results].some((result) =>
    (result.value as FakeTimer).hasRef(),
  );
}

/** Reads one message the way the backup does: its MIME, then its reactions. */
async function read_message(message_id: string): Promise<void> {
  await connector.fetch_mime(TENANT, MAILBOX, message_id);
  await connector.fetch_extended_properties(TENANT, MAILBOX, [message_id]);
}

beforeEach(() => {
  vi.useFakeTimers();
  set_interval = vi.spyOn(globalThis, 'setInterval');
  set_timeout = vi.spyOn(globalThis, 'setTimeout');
  const throttle = new InProcessThrottleCoordinator();
  graph = stub_graph();
  connector = new RateLimitedGraphConnector(
    graph.inner,
    new DefaultMailboxRateLimiterFactory(WINDOW_CAPACITY),
    throttle,
  );
});

afterEach(() => {
  connector.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('RateLimitedGraphConnector waiting on the request window', () => {
  it('reaches a window wait with no Graph request in flight', async () => {
    await read_message('m1');
    let second_read = false;
    void read_message('m2').then(() => {
      second_read = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(second_read).toBe(false);
    expect(graph.in_flight()).toBe(0);
  });

  it('holds the process through that wait, then finishes the read once tokens return', async () => {
    await read_message('m1');
    let second_read = false;
    void read_message('m2').then(() => {
      second_read = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(timers_hold_process()).toBe(true);

    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(second_read).toBe(true);
    expect(timers_hold_process()).toBe(false);
  });

  it('holds nothing once a run is done with tokens left, though the limiter is never shut down', async () => {
    await connector.fetch_mime(TENANT, MAILBOX, 'm1');

    expect(timers_hold_process()).toBe(false);
  });

  it('stops holding the process once released, without sending the parked read early', async () => {
    await read_message('m1');
    let second_read = false;
    void read_message('m2').then(() => {
      second_read = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    connector.release_process_hold();
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1_000);

    expect(timers_hold_process()).toBe(false);
    expect(second_read).toBe(false);
    expect(graph.in_flight()).toBe(0);
  });

  it('does not hold the process for a mailbox first read after the release', async () => {
    connector.release_process_hold();
    await connector.fetch_mime(TENANT, 'mailbox-b', 'm1');
    await connector.fetch_mime(TENANT, 'mailbox-b', 'm2');
    void connector.fetch_mime(TENANT, 'mailbox-b', 'm3');
    await vi.advanceTimersByTimeAsync(0);

    expect(timers_hold_process()).toBe(false);
  });
});
