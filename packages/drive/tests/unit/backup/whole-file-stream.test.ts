import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stream_whole_file_in_chunks } from '@/backup/whole-file-stream';

const CHUNK_SIZE = 4 * 1024 * 1024;

/** A response whose body yields the given parts. */
function streamed_response(parts: Buffer[]): Response {
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        for (const part of parts) yield new Uint8Array(part);
      },
    },
  } as unknown as Response;
}

/**
 * A response that yields one part and then never yields again until the request is aborted,
 * which is what a server that sends headers and then stops looks like from here.
 */
function stalling_response(signal_holder: { signal: AbortSignal | undefined }): Response {
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array(Buffer.alloc(16, 1));
        const { promise, reject } = Promise.withResolvers<never>();
        signal_holder.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
        await promise;
      },
    },
  } as unknown as Response;
}

/** A body that refuses to produce another part once its request was aborted, as fetch does. */
function abort_aware_response(
  signal_holder: { signal: AbortSignal | undefined },
  parts: Buffer[],
): Response {
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        for (const part of parts) {
          if (signal_holder.signal?.aborted === true) {
            throw signal_holder.signal.reason instanceof Error
              ? signal_holder.signal.reason
              : new Error('The operation was aborted');
          }
          yield new Uint8Array(part);
        }
      },
    },
  } as unknown as Response;
}

async function collect(response: Response, stall_timeout_ms = 30_000): Promise<Buffer[]> {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      init?.signal?.addEventListener('abort', () => undefined);
      return Promise.resolve(response);
    }),
  );
  const parts: Buffer[] = [];
  for await (const chunk of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
    chunk_size_bytes: CHUNK_SIZE,
    stall_timeout_ms,
  })) {
    parts.push(chunk);
  }
  return parts;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('stream_whole_file_in_chunks', () => {
  it('re-cuts a body that arrives in unrelated sizes into fixed chunks', async () => {
    const whole = Buffer.alloc(CHUNK_SIZE + 1024, 3);
    const thirds = [
      whole.subarray(0, 1_000_000),
      whole.subarray(1_000_000, 3_500_000),
      whole.subarray(3_500_000),
    ];

    const parts = await collect(streamed_response(thirds.map((part) => Buffer.from(part))));

    expect(parts.map((part) => part.length)).toEqual([CHUNK_SIZE, 1024]);
    const rebuilt = Buffer.concat(parts);
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(
      createHash('sha256').update(whole).digest('hex'),
    );
  });

  it('yields a body smaller than one chunk as a single buffer', async () => {
    const parts = await collect(streamed_response([Buffer.alloc(512, 1)]));

    expect(parts.map((part) => part.length)).toEqual([512]);
  });

  it('yields nothing for an empty body', async () => {
    expect(await collect(streamed_response([]))).toEqual([]);
  });

  it('rejects a chunk size that would loop forever', async () => {
    vi.stubGlobal('fetch', vi.fn());

    // `pending_bytes >= 0` never stops being true, so this would yield until the heap gave out.
    await expect(
      (async () => {
        for await (const _ of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
          chunk_size_bytes: 0,
          stall_timeout_ms: 30_000,
        })) {
          void _;
        }
      })(),
    ).rejects.toThrow(/Invalid chunk size/);
  });

  it('aborts a body that stops arriving', async () => {
    // The Range path bounds every chunk (issue #198); the fallback has to bound the gaps too,
    // or a server that sends headers and then stalls holds the backup open forever.
    vi.useFakeTimers();
    const holder: { signal: AbortSignal | undefined } = { signal: undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        holder.signal = init?.signal;
        return Promise.resolve(stalling_response(holder));
      }),
    );

    const consumed = (async () => {
      for await (const _ of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
        chunk_size_bytes: CHUNK_SIZE,
        stall_timeout_ms: 30_000,
      })) {
        void _;
      }
    })();
    const settled = expect(consumed).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(30_001);
    await settled;
  });

  it('rejects a refused download', async () => {
    await expect(
      collect({ ok: false, status: 403, body: undefined } as unknown as Response),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('does not abort while the consumer is holding a chunk', async () => {
    // The timer bounds the network, not the pipeline behind it. A consumer that spends longer than
    // the stall budget encrypting and uploading a chunk used to look like a server that stopped
    // sending (issue #344).
    vi.useFakeTimers();
    const holder: { signal: AbortSignal | undefined } = { signal: undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        holder.signal = init?.signal;
        return Promise.resolve(
          abort_aware_response(holder, [Buffer.alloc(CHUNK_SIZE, 7), Buffer.alloc(1024, 8)]),
        );
      }),
    );

    const parts: number[] = [];
    for await (const chunk of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
      chunk_size_bytes: CHUNK_SIZE,
      stall_timeout_ms: 30_000,
    })) {
      parts.push(chunk.length);
      await vi.advanceTimersByTimeAsync(90_000);
    }

    // The body refuses to produce another part once its request was aborted, so a second chunk
    // arriving after three stall budgets spent in the consumer is the proof.
    expect(parts).toEqual([CHUNK_SIZE, 1024]);
  });

  it('ends the request when the consumer stops early', async () => {
    const holder: { signal: AbortSignal | undefined } = { signal: undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        holder.signal = init?.signal;
        return Promise.resolve(
          abort_aware_response(holder, [Buffer.alloc(CHUNK_SIZE, 1), Buffer.alloc(CHUNK_SIZE, 2)]),
        );
      }),
    );

    for await (const _ of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
      chunk_size_bytes: CHUNK_SIZE,
      stall_timeout_ms: 30_000,
    })) {
      void _;
      break;
    }

    // Without this the rest of the body keeps arriving for a consumer that has gone.
    expect(holder.signal?.aborted).toBe(true);
  });

  it('does not open a request for a run that is already cancelled', async () => {
    const fetch_spy = vi.fn();
    vi.stubGlobal('fetch', fetch_spy);

    await expect(
      (async () => {
        for await (const _ of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
          chunk_size_bytes: CHUNK_SIZE,
          stall_timeout_ms: 30_000,
          abort_signal: AbortSignal.abort(),
        })) {
          void _;
        }
      })(),
    ).rejects.toThrow();
    expect(fetch_spy).not.toHaveBeenCalled();
  });

  it('ends a body already arriving when the run is cancelled', async () => {
    const cancel = new AbortController();
    const holder: { signal: AbortSignal | undefined } = { signal: undefined };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        holder.signal = init?.signal;
        return Promise.resolve(
          abort_aware_response(holder, [Buffer.alloc(CHUNK_SIZE, 1), Buffer.alloc(CHUNK_SIZE, 2)]),
        );
      }),
    );

    await expect(
      (async () => {
        for await (const chunk of stream_whole_file_in_chunks('https://cdn.test/file', 'item-1', {
          chunk_size_bytes: CHUNK_SIZE,
          stall_timeout_ms: 30_000,
          abort_signal: cancel.signal,
        })) {
          void chunk;
          // Cancelled while the transfer is running, which is the case the interruption predicate
          // could only answer once this item had finished.
          cancel.abort(new Error('run cancelled'));
        }
      })(),
    ).rejects.toThrow(/cancelled|aborted/);
  });
});
