import { afterEach, describe, expect, it, vi } from 'vitest';
import { create_cdn_chunk_downloader } from '@/backup/cdn-chunk-download';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import { honest_range_response, range_response } from './cdn-chunk.fixtures';

/**
 * Issue #344 made the OneDrive copy honour cancellation; the SharePoint copies slept through it,
 * so a cancelled run waited out up to 30 seconds per retry and then recorded the abort against the
 * file (issue #632). These pin the contract on the one shared downloader.
 */

const URL = 'https://cdn.test/item';
const { fetch_file_chunks, download_file_chunked } = create_cdn_chunk_downloader('sharepoint');

async function drain(total: number, signal: AbortSignal, on_chunk?: () => void): Promise<void> {
  for await (const chunk of fetch_file_chunks(URL, total, 'item-1', signal)) {
    void chunk;
    on_chunk?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chunked download cancellation', () => {
  it('stops between chunks when the run is cancelled', async () => {
    const fetch_mock = vi.fn((_url: string, init: { headers: Record<string, string> }) =>
      Promise.resolve(honest_range_response(init)),
    );
    vi.stubGlobal('fetch', fetch_mock);
    const cancel = new AbortController();

    await expect(
      drain(CHUNK_SIZE_BYTES * 4, cancel.signal, () => cancel.abort(new Error('run cancelled'))),
    ).rejects.toThrow(/cancelled/);

    // One chunk fetched, and the three that would have followed were never asked for.
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('never opens a request for a run cancelled before it started', async () => {
    const fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);

    await expect(drain(CHUNK_SIZE_BYTES * 2, AbortSignal.abort())).rejects.toThrow();
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it('ends a retry backoff as soon as the run is cancelled, with the abort reason', async () => {
    vi.useFakeTimers();
    const fetch_mock = vi.fn().mockResolvedValue(range_response(503));
    vi.stubGlobal('fetch', fetch_mock);
    const cancel = new AbortController();

    const outcome = download_file_chunked(URL, 10, 'item-1', cancel.signal).catch(
      (err: unknown) => err,
    );
    // The first attempt failed and the downloader is now in its 1 to 2 second backoff.
    await vi.advanceTimersByTimeAsync(100);
    cancel.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(0);

    const error = await outcome;
    // The abort reason itself, not a chunk failure: a ChunkDownloadError is what the item
    // processor would have recorded against the file's ledger budget.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChunkDownloadError);
    expect((error as Error).message).toBe('Run interrupted by Ctrl+C');
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it('ends a CDN Retry-After wait as soon as the run is cancelled', async () => {
    vi.useFakeTimers();
    const throttled = range_response(429, Buffer.alloc(0), 0, { 'Retry-After': '3600' });
    const fetch_mock = vi.fn().mockResolvedValue(throttled);
    vi.stubGlobal('fetch', fetch_mock);
    const cancel = new AbortController();

    const outcome = download_file_chunked(URL, 10, 'item-1', cancel.signal).catch(
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    cancel.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(0);

    expect(((await outcome) as Error).message).toBe('Run interrupted by Ctrl+C');
    expect(fetch_mock).toHaveBeenCalledTimes(1);
    // No timer is left holding the process open for the rest of the hour.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not relabel an aborted request as a failed chunk', async () => {
    const cancel = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init.signal.addEventListener('abort', () =>
          reject(new Error('This operation was aborted')),
        );
        return promise;
      }),
    );

    const outcome = download_file_chunked(URL, 10, 'item-1', cancel.signal).catch(
      (err: unknown) => err,
    );
    await Promise.resolve();
    cancel.abort(new Error('Run interrupted by Ctrl+C'));

    const error = await outcome;
    expect(error).not.toBeInstanceOf(ChunkDownloadError);
    expect((error as Error).message).toBe('Run interrupted by Ctrl+C');
  });
});
