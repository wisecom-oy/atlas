import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    headers: { get: (): string | null => null },
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(to_array_buffer(body)),
    text: (): Promise<string> => Promise.resolve(''),
  } as unknown as Response;
}

async function collect(url: string, total: number, item = 'item-1'): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of fetch_file_chunks(url, total, item)) parts.push(chunk);
  return Buffer.concat(parts);
}

beforeEach(() => {
  vi.useFakeTimers();
});

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
    const fetch_mock = vi.fn().mockResolvedValue(range_response(503));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = collect('https://cdn.test/file', 10);
    const settled = expect(promise).rejects.toThrow(/HTTP 503/);
    await vi.advanceTimersByTimeAsync(300_000);
    await settled;

    // Six attempts: the first plus MAX_CHUNK_RETRIES.
    expect(fetch_mock).toHaveBeenCalledTimes(6);
  });

  it('slices the whole body when the CDN ignores the Range header', async () => {
    // A 200 means the server sent everything; taking it as the chunk would
    // duplicate the head of the file into every later chunk.
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

    expect(parts[0]?.length).toBe(CHUNK_SIZE);
    expect(parts[1]?.length).toBe(1024);
    expect(parts[1]?.[0]).toBe(2);
  });

  it('rejects a 200 body too short to satisfy the requested range', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(range_response(200, Buffer.alloc(10, 1)));
    vi.stubGlobal('fetch', fetch_mock);

    await expect(collect('https://cdn.test/file', CHUNK_SIZE + 1024)).rejects.toThrow(
      /returned 200 with 10 bytes/,
    );
  });

  it('yields nothing for a zero-byte file', async () => {
    const fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);

    expect((await collect('https://cdn.test/file', 0)).length).toBe(0);
    expect(fetch_mock).not.toHaveBeenCalled();
  });
});
