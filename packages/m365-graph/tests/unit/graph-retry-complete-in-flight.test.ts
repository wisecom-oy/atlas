/**
 * Issue #682. Ctrl+C aborted a restore write that was already on its way to Graph. Graph can
 * commit such a write before the abort lands, so the restore reported a file or message as not
 * written while it existed. A write marked `complete_in_flight` finishes once sent; only the waits
 * before a send are cut short.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { with_graph_retry } from '@/graph-request-error-handler';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CANCEL = new Error('Run interrupted by Ctrl+C');

/** A write Graph answers after 3 s, aborted with its attempt signal the way fetch is. */
function write_answered_after_three_seconds(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('written'), 3_000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** Starts `call` under a run signal, aborts it after 1 s and settles it. */
async function cancelled_one_second_in(call: () => Promise<string>): Promise<unknown> {
  const controller = new AbortController();
  const outcome = run_with_abort_signal(controller.signal, call).then(
    (value) => value,
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  controller.abort(CANCEL);
  await vi.advanceTimersByTimeAsync(3_000);
  return outcome;
}

describe('with_graph_retry complete_in_flight (issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets a write already sent finish when the run is cancelled', async () => {
    const outcome = await cancelled_one_second_in(() =>
      with_graph_retry(write_answered_after_three_seconds, {
        idempotent: false,
        complete_in_flight: true,
      }),
    );

    expect(outcome).toBe('written');
  });

  it('still aborts a call without the option at once', async () => {
    const outcome = await cancelled_one_second_in(() =>
      with_graph_retry(write_answered_after_three_seconds),
    );

    expect(outcome).toBe(CANCEL);
  });

  it('still cuts short the throttle wait before a write is sent again', async () => {
    const send = vi.fn(() =>
      Promise.reject({
        statusCode: 429,
        message: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '360' }),
      }),
    );

    const outcome = await cancelled_one_second_in(() =>
      with_graph_retry(send, { idempotent: false, complete_in_flight: true }),
    );

    expect(outcome).toBe(CANCEL);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
