import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { run_stopping_on_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { with_graph_retry } from '@/graph-request-error-handler';

/**
 * Issue #881: inside one backup run, the first call that spends its retry budget ends every other
 * Graph call of the run, so an outage costs the run one budget instead of one per unit of work.
 */

/** Settles `promise` while simulated time runs through a whole retry budget. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(RETRY_BUDGET_SPAN_MS);
  return promise;
}

describe('with_graph_retry inside a backup run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends nothing for later calls once one call spent its budget', async () => {
    const graph = new GraphOutageFault();
    const outcomes: unknown[] = [];

    const run = run_stopping_on_graph_outage(undefined, async () => {
      for (let unit = 0; unit < 5; unit++) {
        outcomes.push(await with_graph_retry(graph.send).catch((err: unknown) => err));
      }
      return 'committed';
    });
    const failure = await settle(run.catch((err: unknown) => err));

    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) expect(outcome).toBe(failure);
  });

  it('cuts short a concurrent call waiting out its backoff', async () => {
    const outage = new GraphOutageFault();
    const sibling = new GraphOutageFault();
    const settled: Record<string, unknown> = {};

    const run = run_stopping_on_graph_outage(undefined, async () => {
      const exhausted = with_graph_retry(outage.send).catch((err: unknown) => err);
      // Starts once the first call is deep into its budget, so its own budget is far from spent.
      await new Promise((resolve) => setTimeout(resolve, 20 * 60_000));
      const waiting = with_graph_retry(sibling.send).catch((err: unknown) => err);
      settled.exhausted = await exhausted;
      settled.waiting = await waiting;
      settled.waiting_ended_at = Date.now();
    });
    const started_at = Date.now();
    await settle(run.catch(() => undefined));

    expect(outage.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(sibling.requests).toBeLessThan(ATTEMPTS_PER_RETRY_CHAIN);
    expect(settled.waiting).toBe(settled.exhausted);
    // Ends with the first call's budget, not five minutes of backoff later.
    expect(Number(settled.waiting_ended_at) - started_at).toBeLessThan(25 * 60_000);
  });

  it('lets a request already in flight complete after the outage is recorded', async () => {
    const graph = new GraphOutageFault();
    let release: (value: string) => void = () => undefined;
    const in_flight = new Promise<string>((resolve) => {
      release = resolve;
    });
    let slow_read: unknown;

    const run = run_stopping_on_graph_outage(undefined, async () => {
      // Sent before the outage and slower than the whole budget, so it is still on the wire when the
      // latch trips; the long attempt timeout keeps it from being retried meanwhile.
      const reading = with_graph_retry(() => in_flight, { timeout_ms: 2 * RETRY_BUDGET_SPAN_MS });
      await with_graph_retry(graph.send).catch(() => undefined);
      release('read');
      slow_read = await reading;
    });
    const failure = await settle(run.catch((err: unknown) => err));

    expect(slow_read).toBe('read');
    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(graph.requests).toBe(ATTEMPTS_PER_RETRY_CHAIN);
  });

  it('still rides out an outage that ends within one budget', async () => {
    let failures_left = 6;
    const recovering = vi.fn(async () => {
      if (failures_left-- > 0) throw Object.assign(new Error(''), { statusCode: 503 });
      return 'page';
    });

    const run = run_stopping_on_graph_outage(undefined, () => with_graph_retry(recovering));

    await expect(settle(run)).resolves.toBe('page');
    expect(recovering).toHaveBeenCalledTimes(7);
  });

  it('keeps a fresh budget per call outside a backup run', async () => {
    const graph = new GraphOutageFault();

    await settle(with_graph_retry(graph.send).catch(() => undefined));
    await settle(with_graph_retry(graph.send).catch(() => undefined));

    expect(graph.requests).toBe(2 * ATTEMPTS_PER_RETRY_CHAIN);
  });

  it('keeps rejecting with the cancellation when the run is cancelled', async () => {
    const graph = new GraphOutageFault();
    const controller = new AbortController();
    const reason = new Error('cancelled by operator');

    const call = run_with_abort_signal(controller.signal, () =>
      run_stopping_on_graph_outage(controller.signal, () => with_graph_retry(graph.send)),
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(reason);

    await expect(call).resolves.toBe(reason);
  });
});
