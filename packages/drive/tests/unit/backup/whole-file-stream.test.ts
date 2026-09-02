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
});
