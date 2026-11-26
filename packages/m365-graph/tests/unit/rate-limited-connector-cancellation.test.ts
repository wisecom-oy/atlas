/**
 * Issue #874. An Outlook call parked in its mailbox's limiter, on a cooldown, the request window or a
 * concurrency slot, ignored Ctrl+C and the SDK's `abort_signal`, so a soft stop waited for the very
 * cooldown it was meant to drop. Cancelling must end the wait at once and never send the request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';
import { ThrottledError } from '@wisecom/atlas-types';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  record_graph_outage,
  run_stopping_on_graph_outage,
} from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';

const MAILBOX = 'mailbox-a';
const HOUR_MS = 3_600_000;
const INTERRUPTED = new Error('Run interrupted by Ctrl+C');

let throttle: InProcessThrottleCoordinator;
let send: ReturnType<typeof vi.fn<() => Promise<Buffer>>>;
let connector: RateLimitedGraphConnector;

/** A connector whose MIME read is the Graph request; `window` and `slots` size the mailbox pacing. */
function build(window?: number, slots?: number): void {
  connector = new RateLimitedGraphConnector(
    { fetch_mime: send } as unknown as MailboxConnector,
    new DefaultMailboxRateLimiterFactory(window, slots),
    throttle,
  );
}

/** Starts a MIME read under `signal`, and reports whether and how it settled. */
function read_under(signal: AbortSignal) {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  const read = run_with_abort_signal(signal, () => connector.fetch_mime('t', MAILBOX, 'm1'));
  void read.then(
    () => (state.settled = true),
    (err: unknown) => Object.assign(state, { settled: true, error: err }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  throttle = new InProcessThrottleCoordinator();
  send = vi.fn(() => Promise.resolve(Buffer.from('mime')));
  build();
});

afterEach(() => {
  connector.shutdown();
  throttle.clear();
  vi.useRealTimers();
});

describe('RateLimitedGraphConnector cancelled while waiting to send (issue #874)', () => {
  it('ends a wait on the mailbox cooldown at once, without sending or dropping the cooldown', async () => {
    throttle.raise('outlook', HOUR_MS, { ownerId: MAILBOX });
    const controller = new AbortController();
    const read = read_under(controller.signal);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read.settled).toBe(false);

    controller.abort(INTERRUPTED);
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toEqual({ settled: true, error: INTERRUPTED });
    expect(send).not.toHaveBeenCalled();
    expect(throttle.is_cooling('outlook', { ownerId: MAILBOX })).toBe(true);
  });

  it('ends a wait for request-window tokens at once, without sending', async () => {
    build(1);
    await connector.fetch_mime('t', MAILBOX, 'm0');
    const controller = new AbortController();
    const read = read_under(controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read.settled).toBe(false);

    controller.abort(INTERRUPTED);
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toEqual({ settled: true, error: INTERRUPTED });
    expect(send).toHaveBeenCalledOnce();
  });

  it('ends a wait for a concurrency slot at once, and leaves the slot to the next call', async () => {
    build(undefined, 1);
    const in_flight = Promise.withResolvers<Buffer>();
    send.mockReturnValueOnce(in_flight.promise);
    const first = connector.fetch_mime('t', MAILBOX, 'm0');
    const controller = new AbortController();
    const read = read_under(controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort(INTERRUPTED);
    await vi.advanceTimersByTimeAsync(0);
    in_flight.resolve(Buffer.from('mime'));
    await first;

    expect(read).toEqual({ settled: true, error: INTERRUPTED });
    expect(send).toHaveBeenCalledOnce();
    await expect(connector.fetch_mime('t', MAILBOX, 'm2')).resolves.toBeInstanceOf(Buffer);
  });

  it('does not send a call whose run was cancelled before it started', async () => {
    const controller = new AbortController();
    controller.abort(INTERRUPTED);

    const read = read_under(controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(read.error).toBe(INTERRUPTED);
    expect(send).not.toHaveBeenCalled();
  });

  it('still waits out the whole cooldown when nothing cancels it', async () => {
    throttle.raise('outlook', HOUR_MS, { ownerId: MAILBOX });
    const read = read_under(new AbortController().signal);

    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledOnce();
    expect(read).toEqual({ settled: true });
  });

  it('ends the wait with the outage once another call of the run spent its budget', async () => {
    throttle.raise('outlook', HOUR_MS, { ownerId: MAILBOX });
    const outage = new ThrottledError('kept throttling after 12 retries');

    const run = run_stopping_on_graph_outage(undefined, async () => {
      const read = connector.fetch_mime('t', MAILBOX, 'm1');
      await vi.advanceTimersByTimeAsync(1_000);
      record_graph_outage(outage);
      return read;
    });

    await expect(run).rejects.toBe(outage);
    expect(send).not.toHaveBeenCalled();
  });
});
