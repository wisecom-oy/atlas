import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { download_file_chunked } from '@/adapters/graph-onedrive-chunked-download';

// Issue #36: Graph and the CDN in front of it return transient 500/502 under
// load. A chunk that hits one must be retried, not turned into a skipped file.

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

describe('download_file_chunked', () => {
  const payload = Buffer.from('chunk-payload');

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([500, 502])('retries a chunk that failed with HTTP %i', async (status) => {
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(range_response(status))
      .mockResolvedValueOnce(range_response(206, payload));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = download_file_chunked('https://cdn.test/file', payload.length, 'item-1');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await promise).toEqual(payload);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it('fails a chunk that returned HTTP 404 without retrying', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(range_response(404));
    vi.stubGlobal('fetch', fetch_mock);

    await expect(
      download_file_chunked('https://cdn.test/file', payload.length, 'item-1'),
    ).rejects.toThrow('HTTP 404');
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });
});
