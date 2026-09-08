import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetch_file_chunks } from '@/services/backup/large-file-chunk-download';

// Issue #338, mirrored from the OneDrive suite. The two drive downloaders are copies, and
// divergent coverage between them is what let the replication gate divergence through (#190).

const CHUNK_SIZE = 4 * 1024 * 1024;
const TOTAL_BYTES = 2 * CHUNK_SIZE;

interface RangeInit {
  readonly headers: Record<string, string>;
}

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

describe('SharePoint chunked download integrity (issue #338)', () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(206, Buffer.alloc(CHUNK_SIZE, 1), `bytes 0-${CHUNK_SIZE - 1}/${TOTAL_BYTES}`),
        ),
      ),
    );

    await expect(collect()).rejects.toThrow(/was answered with bytes 0-4194303/);
  });

  it('fails rather than appending when Range stops being honoured mid-file', async () => {
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
