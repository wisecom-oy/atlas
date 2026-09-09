import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetch_file_chunks } from '@/services/backup/large-file-chunk-download';

/**
 * Issue #344, the SharePoint twin. The two chunked-download adapters are separate copies that have
 * drifted into the same bug before, so the cancellation contract is pinned in both.
 */

const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

const URL = 'https://cdn.test/item';

/** A CDN that answers Range requests, and fails the read once its request was aborted. */
function stub_cdn(): { requests: () => number } {
  let requests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        _url: string,
        init: { headers: { Range: string }; signal?: AbortSignal },
      ): Promise<Response> => {
        requests++;
        init.signal?.throwIfAborted();
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
        const body = Buffer.alloc(Number(end) - Number(start) + 1, 1);
        return {
          status: 206,
          headers: {
            get: (name: string): string | null =>
              name.toLowerCase() === 'content-range' ? `bytes ${start}-${end}/*` : null,
          },
          arrayBuffer: async () => {
            init.signal?.throwIfAborted();
            return body.buffer.slice(0, body.length);
          },
        } as unknown as Response;
      },
    ),
  );
  return { requests: () => requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chunked download cancellation (issue #344)', () => {
  it('stops between chunks when the run is cancelled', async () => {
    const cdn = stub_cdn();
    const cancel = new AbortController();

    await expect(
      (async () => {
        for await (const chunk of fetch_file_chunks(
          URL,
          CHUNK_SIZE_BYTES * 4,
          'item-1',
          cancel.signal,
        )) {
          void chunk;
          cancel.abort(new Error('run cancelled'));
        }
      })(),
    ).rejects.toThrow(/cancelled/);

    // One chunk fetched, and the three that would have followed were never asked for.
    expect(cdn.requests()).toBe(1);
  });

  it('never opens a request for a run cancelled before it started', async () => {
    const cdn = stub_cdn();

    await expect(
      (async () => {
        for await (const chunk of fetch_file_chunks(
          URL,
          CHUNK_SIZE_BYTES * 2,
          'item-1',
          AbortSignal.abort(),
        )) {
          void chunk;
        }
      })(),
    ).rejects.toThrow();

    expect(cdn.requests()).toBe(0);
  });
});
