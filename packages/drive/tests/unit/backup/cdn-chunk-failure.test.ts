import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify_download_failure } from '@wisecom/atlas-m365-graph';
import { create_cdn_chunk_downloader } from '@/backup/cdn-chunk-download';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import { range_response } from './cdn-chunk.fixtures';

/**
 * A chunk that fails for good used to be rethrown as a plain `Error` holding only the message, so
 * `classify_download_failure` saw `unclassified`: an expired URL was never refreshed and a 403 was
 * never named (issue #632). The Retry-After cases pin the shared parser on this path (issue #628).
 */

const URL = 'https://cdn.test/item';
const { download_file_chunked } = create_cdn_chunk_downloader('sharepoint');

async function failure_of(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chunk failure typing', () => {
  it.each([401, 403])(
    'carries a CDN %i as status_code and cause, which classifies as an expired URL',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(range_response(status)));

      const error = await failure_of(download_file_chunked(URL, 10, 'item-1'));

      expect(error).toBeInstanceOf(ChunkDownloadError);
      expect((error as ChunkDownloadError).status_code).toBe(status);
      expect((error as Error).cause).toBeInstanceOf(CdnHttpError);
      expect(classify_download_failure(error)).toBe('expired_url');
    },
  );

  it('keeps a Graph-shaped failure reachable through cause', async () => {
    const refusal = { statusCode: 403, code: 'notAllowed' };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refusal));

    const error = await failure_of(download_file_chunked(URL, 10, 'item-1'));

    expect(error).toBeInstanceOf(ChunkDownloadError);
    expect((error as ChunkDownloadError).status_code).toBeUndefined();
    expect((error as Error).cause).toBe(refusal);
    expect(classify_download_failure(error)).toBe('service_refused');
  });

  it('leaves a status that is neither stale nor refused unclassified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(range_response(404)));

    const error = await failure_of(download_file_chunked(URL, 10, 'item-1'));

    expect((error as ChunkDownloadError).status_code).toBe(404);
    expect(classify_download_failure(error)).toBe('unclassified');
  });

  // Undici holds the connection until an unread body is cancelled (CodeRabbit on #677).
  it('cancels the unread body of a refused chunk, even when the cancel rejects', async () => {
    const refused = range_response(404);
    const cancel = vi.fn(() => Promise.reject(new Error('already closed')));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ...refused, body: { cancel } }));

    const error = await failure_of(download_file_chunked(URL, 10, 'item-1'));

    expect((error as ChunkDownloadError).status_code).toBe(404);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('chunk Retry-After (issue #628)', () => {
  it('waits until an HTTP-date Retry-After rather than the default backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:27:00Z'));
    const throttled = range_response(429, Buffer.alloc(0), 0, {
      'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
    const payload = Buffer.from('chunk-payload');
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(range_response(206, payload));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = download_file_chunked(URL, payload.length, 'item-1');
    // Past the 1 to 2 second default backoff, still inside the 60 seconds the date asks for.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual(payload);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it('clamps an overflowing numeric Retry-After to an hour instead of retrying at once', async () => {
    vi.useFakeTimers();
    // 2^31 seconds: as milliseconds it is far past setTimeout's 2^31-1 ceiling, which Node treats
    // as 1 ms.
    const throttled = range_response(429, Buffer.alloc(0), 0, { 'Retry-After': '2147483648' });
    const payload = Buffer.from('chunk-payload');
    const fetch_mock = vi
      .fn()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(range_response(206, payload));
    vi.stubGlobal('fetch', fetch_mock);

    const promise = download_file_chunked(URL, payload.length, 'item-1');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual(payload);
  });
});
