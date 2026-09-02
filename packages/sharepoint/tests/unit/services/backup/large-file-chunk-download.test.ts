import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetch_file_chunks } from '@/services/backup/large-file-chunk-download';

// The OneDrive twin of this file has had tests since issue #36; this one had
// none. Divergent coverage between the two drive pipelines is what let the
// replication gate divergence through (#190), so it gets the same suite.

const CHUNK_SIZE = 4 * 1024 * 1024;

function to_array_buffer(body: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

function range_response(status: number, body = Buffer.alloc(0)): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (): string | null => null },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(to_array_buffer(body)),
    text: (): Promise<string> => Promise.resolve(''),
    // The Range-ignored path cancels the body unread, and the streamed fallback iterates it.
    body: {
      cancel: (): Promise<void> => Promise.resolve(),
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        // Two parts, so the re-cut has to join across reads rather than pass one buffer through.
        yield new Uint8Array(body.subarray(0, Math.ceil(body.length / 2)));
        yield new Uint8Array(body.subarray(Math.ceil(body.length / 2)));
      },
    },
  } as unknown as Response;
}

async function collect(url: string, total: number, item = 'item-1'): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of fetch_file_chunks(url, total, item)) parts.push(chunk);
  return Buffer.concat(parts);
}

// Fake timers are installed per test, not globally: leaving them on for the streamed fallback
// routes every promise resolution through the faked queue and turns a 4 MiB re-cut into seconds.
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetch_file_chunks', () => {
  it('requests one Range per chunk and yields them in order', async () => {
    const first = Buffer.alloc(CHUNK_SIZE, 1);
    const second = Buffer.alloc(1024, 2);
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(range_response(206, first))
      .mockResolvedValueOnce(range_response(206, second));
    vi.stubGlobal('fetch', fetch_mock);

    const body = await collect('https://cdn.test/file', CHUNK_SIZE + 1024);

    expect(body.length).toBe(CHUNK_SIZE + 1024);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
    const ranges = fetch_mock.mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers['Range'],
    );
    expect(ranges).toEqual([
      `bytes=0-${CHUNK_SIZE - 1}`,
      `bytes=${CHUNK_SIZE}-${CHUNK_SIZE + 1023}`,
    ]);
  });

  it.each([429, 503, 504])('retries a chunk the CDN refused with HTTP %i', async (status) => {
    vi.useFakeTimers();
    const payload = Buffer.from('chunk-payload');
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(range_response(status))
      .mockResolvedValueOnce(range_response(206, payload));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = collect('https://cdn.test/file', payload.length);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await promise).toEqual(payload);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it('fails a chunk that returned HTTP 404 without retrying', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(range_response(404));
    vi.stubGlobal('fetch', fetch_mock);

    // A missing object is not a transient CDN fault, and retrying it spends the
    // budget that a genuinely transient chunk needs.
    await expect(collect('https://cdn.test/file', 10)).rejects.toThrow(/HTTP 404/);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget is spent', async () => {
    vi.useFakeTimers();
    const fetch_mock = vi.fn().mockResolvedValue(range_response(503));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = collect('https://cdn.test/file', 10);
    const settled = expect(promise).rejects.toThrow(/HTTP 503/);
    await vi.advanceTimersByTimeAsync(300_000);
    await settled;

    // Six attempts: the first plus MAX_CHUNK_RETRIES.
    expect(fetch_mock).toHaveBeenCalledTimes(6);
  });

  it('stops asking for ranges once the CDN answers one with the whole file (issue #301)', async () => {
    const whole = Buffer.concat([Buffer.alloc(CHUNK_SIZE, 1), Buffer.alloc(1024, 2)]);
    const fetch_mock = vi.fn().mockResolvedValue(range_response(200, whole));
    vi.stubGlobal('fetch', fetch_mock);

    const parts: Buffer[] = [];
    for await (const chunk of fetch_file_chunks(
      'https://cdn.test/file',
      CHUNK_SIZE + 1024,
      'item-1',
    )) {
      parts.push(chunk);
    }

    // Two requests, not one per chunk: the Range probe, then one streamed download. Fetching
    // per chunk cost the whole file every time, so a 1 GiB item moved 256 GiB.
    expect(fetch_mock).toHaveBeenCalledTimes(2);
    expect((fetch_mock.mock.calls[1] as unknown[])[1]).toBeUndefined();
    // Compared by digest, not by `toEqual`: a deep equality over 4 MiB of bytes takes seconds.
    const rebuilt = Buffer.concat(parts);
    expect(rebuilt.length).toBe(whole.length);
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(
      createHash('sha256').update(whole).digest('hex'),
    );
    expect(parts[0]?.length).toBe(CHUNK_SIZE);
    expect(parts[1]?.length).toBe(1024);
  });

  it('fails the streamed fallback when the plain download is refused', async () => {
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(range_response(200, Buffer.alloc(CHUNK_SIZE + 1024, 1)))
      .mockResolvedValueOnce(range_response(403));
    vi.stubGlobal('fetch', fetch_mock);

    await expect(collect('https://cdn.test/file', CHUNK_SIZE + 1024)).rejects.toThrow(
      /HTTP 403 for the streamed download/,
    );
  });

  it('accepts a 200 for a single-chunk item, where the whole file is the chunk', async () => {
    const whole = Buffer.alloc(1024, 7);
    const fetch_mock = vi.fn().mockResolvedValue(range_response(200, whole));
    vi.stubGlobal('fetch', fetch_mock);

    // One chunk means a 200 is not the server ignoring Range, so there is nothing to fall back
    // to and no second request to make.
    expect(await collect('https://cdn.test/file', 1024)).toEqual(whole);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('rejects a single-chunk 200 body too short to satisfy the requested range', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(range_response(200, Buffer.alloc(5, 1)));
    vi.stubGlobal('fetch', fetch_mock);

    await expect(collect('https://cdn.test/file', 10)).rejects.toThrow(/returned 200 with 5 bytes/);
  });

  it('yields nothing for a zero-byte file', async () => {
    const fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);

    expect((await collect('https://cdn.test/file', 0)).length).toBe(0);
    expect(fetch_mock).not.toHaveBeenCalled();
  });
});
