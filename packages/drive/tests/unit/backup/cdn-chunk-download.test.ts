import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create_cdn_chunk_downloader } from '@/backup/cdn-chunk-download';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { range_response } from './cdn-chunk.fixtures';

// One downloader serves both drive workloads (issue #632). It replaces three copies, so this suite
// carries the cases each copy had: retry by status (#36, #618), the Range fallback (#301) and the
// single-chunk 200.

const downloader = create_cdn_chunk_downloader('sharepoint');

async function collect(url: string, total: number, item = 'item-1'): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of downloader.fetch_file_chunks(url, total, item)) parts.push(chunk);
  return Buffer.concat(parts);
}

// Fake timers are installed per test, not globally: leaving them on for the streamed fallback
// routes every promise resolution through the faked queue and turns a 4 MiB re-cut into seconds.
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('create_cdn_chunk_downloader', () => {
  it('requests one Range per chunk and yields them in order', async () => {
    const first = Buffer.alloc(CHUNK_SIZE_BYTES, 1);
    const second = Buffer.alloc(1024, 2);
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(range_response(206, first))
      .mockResolvedValueOnce(range_response(206, second, CHUNK_SIZE_BYTES));
    vi.stubGlobal('fetch', fetch_mock);

    const body = await collect('https://cdn.test/file', CHUNK_SIZE_BYTES + 1024);

    expect(body.length).toBe(CHUNK_SIZE_BYTES + 1024);
    const ranges = fetch_mock.mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers['Range'],
    );
    expect(ranges).toEqual([
      `bytes=0-${CHUNK_SIZE_BYTES - 1}`,
      `bytes=${CHUNK_SIZE_BYTES}-${CHUNK_SIZE_BYTES + 1023}`,
    ]);
  });

  it('collects the chunks into one buffer through download_file_chunked', async () => {
    const payload = Buffer.from('chunk-payload');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(range_response(206, payload)));

    await expect(
      downloader.download_file_chunked('https://cdn.test/file', payload.length, 'item-1'),
    ).resolves.toEqual(payload);
  });

  it.each([429, 500, 502, 503, 504])(
    'retries a chunk the CDN refused with HTTP %i',
    async (status) => {
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
    },
  );

  it('fails a chunk that returned HTTP 404 without retrying', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(range_response(404));
    vi.stubGlobal('fetch', fetch_mock);

    await expect(collect('https://cdn.test/file', 10)).rejects.toThrow(/HTTP 404/);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('classifies on the status, not on digits in the item id or byte range (issue #618)', async () => {
    const fetch_mock = vi.fn().mockResolvedValue(range_response(404));
    vi.stubGlobal('fetch', fetch_mock);

    // The error text reads "HTTP 404 for chunk bytes=0-9 of item-503-429", which a substring
    // test took for a 503 and retried.
    await expect(collect('https://cdn.test/file', 10, 'item-503-429')).rejects.toThrow(/HTTP 404/);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('retries a chunk whose connection failed before any response', async () => {
    vi.useFakeTimers();
    const payload = Buffer.from('chunk-payload');
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetch_mock = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(range_response(206, payload));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = collect('https://cdn.test/file', payload.length);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await promise).toEqual(payload);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget is spent', async () => {
    vi.useFakeTimers();
    const fetch_mock = vi.fn().mockResolvedValue(range_response(503));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = collect('https://cdn.test/file', 10);
    const settled = expect(promise).rejects.toThrow(/after 6 attempts: HTTP 503/);
    await vi.advanceTimersByTimeAsync(300_000);
    await settled;

    // Six attempts: the first plus five retries.
    expect(fetch_mock).toHaveBeenCalledTimes(6);
  });

  it('names the workload the downloader was built for', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(range_response(404)));
    const onedrive = create_cdn_chunk_downloader('onedrive');

    await expect(
      onedrive.download_file_chunked('https://cdn.test/file', 10, 'item-1'),
    ).rejects.toThrow('Failed chunk 1/1 of OneDrive item item-1');
  });

  it('stops asking for ranges once the CDN answers one with the whole file (issue #301)', async () => {
    const whole = Buffer.concat([Buffer.alloc(CHUNK_SIZE_BYTES, 1), Buffer.alloc(1024, 2)]);
    const fetch_mock = vi.fn().mockResolvedValue(range_response(200, whole));
    vi.stubGlobal('fetch', fetch_mock);

    const parts: Buffer[] = [];
    for await (const chunk of downloader.fetch_file_chunks(
      'https://cdn.test/file',
      whole.length,
      'item-1',
    )) {
      parts.push(chunk);
    }

    // Two requests, not one per chunk: the Range probe, then one streamed download.
    expect(fetch_mock).toHaveBeenCalledTimes(2);
    const streamed_init = (fetch_mock.mock.calls[1] as unknown[])[1] as {
      headers?: Record<string, string>;
      signal?: AbortSignal;
    };
    expect(streamed_init.headers).toBeUndefined();
    expect(streamed_init.signal).toBeInstanceOf(AbortSignal);
    // Compared by digest, not by `toEqual`: a deep equality over 4 MiB of bytes takes seconds.
    const rebuilt = Buffer.concat(parts);
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(
      createHash('sha256').update(whole).digest('hex'),
    );
    expect(parts.map((part) => part.length)).toEqual([CHUNK_SIZE_BYTES, 1024]);
  });

  it('fails the streamed fallback when the plain download is refused', async () => {
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(range_response(200, Buffer.alloc(CHUNK_SIZE_BYTES + 1024, 1)))
      .mockResolvedValueOnce(range_response(403));
    vi.stubGlobal('fetch', fetch_mock);

    await expect(collect('https://cdn.test/file', CHUNK_SIZE_BYTES + 1024)).rejects.toMatchObject({
      message: expect.stringMatching(/HTTP 403 for the streamed download/),
      status_code: 403,
    });
  });

  it('accepts a 200 for a single-chunk item, where the whole file is the chunk', async () => {
    const whole = Buffer.alloc(1024, 7);
    const fetch_mock = vi.fn().mockResolvedValue(range_response(200, whole));
    vi.stubGlobal('fetch', fetch_mock);

    expect(await collect('https://cdn.test/file', 1024)).toEqual(whole);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('rejects a single-chunk 200 body too short to satisfy the requested range', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(range_response(200, Buffer.alloc(5, 1))));

    await expect(collect('https://cdn.test/file', 10)).rejects.toThrow(/returned 200 with 5 bytes/);
  });

  it('yields nothing for a zero-byte file', async () => {
    const fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);

    expect((await collect('https://cdn.test/file', 0)).length).toBe(0);
    expect(fetch_mock).not.toHaveBeenCalled();
  });
});
