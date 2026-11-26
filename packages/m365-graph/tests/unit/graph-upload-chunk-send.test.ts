/**
 * Issue #891. An attachment chunk sent through the Graph client ran under the default retry policy,
 * so the final chunk, which creates the attachment, was sent up to 13 times after a 5xx or a
 * timeout, and a timed-out PUT was left running beside its retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { send_upload_chunk, type UploadChunk } from '@/graph-upload-session-chunk';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FINAL: UploadChunk = {
  role: 'commit',
  range: 'bytes 0-99/100',
  bytes: 100,
  item: 'attachment',
};
const FIRST: UploadChunk = { ...FINAL, role: 'intermediate', range: 'bytes 0-49/100' };

/** One scripted answer per send: a value, an error to throw, or `hang` to never answer. */
type Answer = unknown;
const HANG = Symbol('hang');

/** A chunk PUT that answers from `answers` and records the signal each send was given. */
function scripted_put(answers: Answer[]): {
  send: (signal: AbortSignal) => Promise<unknown>;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const send = (signal: AbortSignal): Promise<unknown> => {
    signals.push(signal);
    const answer = answers[signals.length - 1];
    if (answer === HANG) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { send, signals };
}

/** Starts `call` and settles it once `ms` of fake time has passed. */
async function settle_after(call: Promise<unknown>, ms: number): Promise<unknown> {
  const outcome = call.then(
    (value) => value,
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('send_upload_chunk on the final chunk', () => {
  it('sends a chunk answered 504 once and reports the outcome as unknown', async () => {
    // The 416 is what a re-send to a committed session would get; it must never be requested.
    const put = scripted_put([
      graph_error(504, 'GatewayTimeout'),
      graph_error(416, 'invalidRange'),
    ]);

    const outcome = await settle_after(send_upload_chunk(FINAL, put.send), 600_000);

    expect(put.signals).toHaveLength(1);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toMatch(/outcome unknown, the attachment may exist/);
    expect((outcome as Error).message).toContain('HTTP 504');
  });

  it('sends a chunk whose connection reset once and reports the outcome as unknown', async () => {
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const put = scripted_put([reset, { id: 'att-1' }]);

    const outcome = await settle_after(send_upload_chunk(FINAL, put.send), 600_000);

    expect(put.signals).toHaveLength(1);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('aborts a hanging chunk at its 60 s deadline and does not send it again', async () => {
    const put = scripted_put([HANG, { id: 'att-1' }]);

    const outcome = await settle_after(send_upload_chunk(FINAL, put.send), 60_000);

    expect(put.signals).toHaveLength(1);
    expect(put.signals[0]?.aborted).toBe(true);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('returns control within the deadline when Ctrl+C lands while the chunk hangs', async () => {
    const put = scripted_put([HANG]);
    const controller = new AbortController();
    const call = run_with_abort_signal(controller.signal, () => send_upload_chunk(FINAL, put.send));
    let settled = false;
    const outcome = call.then(
      () => undefined,
      (err: unknown) => err,
    );
    void outcome.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(58_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    expect(await outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('sends the chunk again after a 429, which Graph answers without processing it', async () => {
    const throttled = Object.assign(graph_error(429, 'TooManyRequests'), {
      headers: { 'retry-after': '1' },
    });
    const put = scripted_put([throttled, { id: 'att-1' }]);

    const outcome = await settle_after(send_upload_chunk(FINAL, put.send), 10_000);

    expect(outcome).toEqual({ id: 'att-1' });
    expect(put.signals).toHaveLength(2);
  });

  it('reports a 416 on the re-send after a throttling 503 as an unknown outcome', async () => {
    const throttled = Object.assign(graph_error(503, 'ServiceUnavailable'), {
      headers: { 'retry-after': '1' },
    });
    const put = scripted_put([throttled, graph_error(416, 'invalidRange')]);

    const outcome = await settle_after(send_upload_chunk(FINAL, put.send), 10_000);

    expect(put.signals).toHaveLength(2);
    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
  });

  it('reports a 4xx on the first send as the refusal it is', async () => {
    const put = scripted_put([graph_error(400, 'BadRequest')]);

    const outcome = await settle_after(send_upload_chunk(FINAL, put.send), 1_000);

    expect(outcome).not.toBeInstanceOf(UploadCommitUnknownError);
    expect(outcome).toMatchObject({ statusCode: 400 });
  });

  it('keeps a cancellation during a throttle wait a cancellation', async () => {
    const throttled = Object.assign(graph_error(429, 'TooManyRequests'), {
      headers: { 'retry-after': '30' },
    });
    const put = scripted_put([throttled, { id: 'att-1' }]);
    const controller = new AbortController();
    const cancel = new Error('Run interrupted by Ctrl+C');
    const call = run_with_abort_signal(controller.signal, () => send_upload_chunk(FINAL, put.send));
    const outcome = call.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(cancel);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toBe(cancel);
    expect(put.signals).toHaveLength(1);
  });
});

describe('send_upload_chunk on an intermediate chunk', () => {
  it('sends the chunk again after a 500', async () => {
    const put = scripted_put([graph_error(500, 'InternalServerError'), {}]);

    const outcome = await settle_after(send_upload_chunk(FIRST, put.send), 10_000);

    expect(outcome).toEqual({});
    expect(put.signals).toHaveLength(2);
  });

  it('aborts a timed-out chunk before its retry is sent', async () => {
    const put = scripted_put([HANG, {}]);
    const aborted_before_retry: boolean[] = [];
    const send = (signal: AbortSignal): Promise<unknown> => {
      aborted_before_retry.push(put.signals.every((earlier) => earlier.aborted));
      return put.send(signal);
    };

    const outcome = await settle_after(send_upload_chunk(FIRST, send), 70_000);

    expect(outcome).toEqual({});
    expect(put.signals).toHaveLength(2);
    expect(aborted_before_retry).toEqual([true, true]);
  });

  it('does not wrap a failure of an intermediate chunk as an unknown outcome', async () => {
    const put = scripted_put([graph_error(404, 'itemNotFound')]);

    const outcome = await settle_after(send_upload_chunk(FIRST, put.send), 1_000);

    expect(outcome).toMatchObject({ statusCode: 404 });
    expect(put.signals).toHaveLength(1);
  });
});
