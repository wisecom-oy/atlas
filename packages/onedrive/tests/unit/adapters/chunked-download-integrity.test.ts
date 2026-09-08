import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE_BYTES, fetch_file_chunks } from '@/adapters/graph-onedrive-chunked-download';

// Issue #338: a Range response was accepted without checking its length or its Content-Range, so a
// short, duplicated or restarted body was encrypted and hashed into a backup that verifies against
// itself. Each case below produced `stored: true` before the fix.

const TOTAL_BYTES = 2 * CHUNK_SIZE_BYTES;

function to_array_buffer(body: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

function response(status: number, body: Buffer, content_range?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-range' ? (content_range ?? null) : null,
    },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(to_array_buffer(body)),
    body: {
      cancel: (): Promise<void> => Promise.resolve(),
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array(body);
      },
    },
  } as unknown as Response;
}

interface RangeInit {
  readonly headers: Record<string, string>;
}

function requested_range(init: RangeInit): { start: number; end: number } {
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers['Range'] ?? '')!;
  return { start: Number(start), end: Number(end) };
}

/** A well-behaved CDN: exactly the requested bytes, with the matching Content-Range. */
function honest_range(init: RangeInit): Response {
  const { start, end } = requested_range(init);
  return response(206, Buffer.alloc(end - start + 1, 1), `bytes ${start}-${end}/${TOTAL_BYTES}`);
}

async function collect(): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of fetch_file_chunks('https://cdn.test/file', TOTAL_BYTES, 'item-1')) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chunked download integrity (issue #338)', () => {
  it('yields the whole file when every range is answered honestly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RangeInit) => Promise.resolve(honest_range(init))),
    );

    expect((await collect()).length).toBe(TOTAL_BYTES);
  });

  it('fails a 206 whose body is shorter than the range it claims to answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RangeInit) => {
        const { start, end } = requested_range(init);
        return Promise.resolve(
          response(206, Buffer.alloc(1, 1), `bytes ${start}-${end}/${TOTAL_BYTES}`),
        );
      }),
    );

    await expect(collect()).rejects.toThrow(/returned 1 bytes, expected 4194304/);
  });

  it('fails a 206 that answers a different range than the one requested', async () => {
    // The shape a duplicated or reordered chunk takes on the wire: a full-length body carrying
    // bytes the caller did not ask for. Without the header check it concatenates silently.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(
            206,
            Buffer.alloc(CHUNK_SIZE_BYTES, 1),
            `bytes 0-${CHUNK_SIZE_BYTES - 1}/${TOTAL_BYTES}`,
          ),
        ),
      ),
    );

    await expect(collect()).rejects.toThrow(/was answered with bytes 0-4194303/);
  });

  it('fails rather than appending when Range stops being honoured mid-file', async () => {
    // The fallback restarts at byte zero, so continuing it after a chunk has been consumed would
    // encrypt a prefix followed by the whole file.
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RangeInit) =>
        Promise.resolve(
          call++ === 0 ? honest_range(init) : response(200, Buffer.alloc(TOTAL_BYTES, 1)),
        ),
      ),
    );

    await expect(collect()).rejects.toThrow(/stopped being honoured .* after 1 chunk/);
  });

  it('still takes the streamed fallback when the first range is already ignored', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, Buffer.alloc(TOTAL_BYTES, 1)))),
    );

    expect((await collect()).length).toBe(TOTAL_BYTES);
  });
});
