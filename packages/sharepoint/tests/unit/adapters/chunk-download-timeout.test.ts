import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_SIZE_BYTES,
  compute_chunk_timeout_ms,
  download_file_chunked,
} from '@/adapters/graph-sharepoint-chunked-download';

/**
 * Issue #198: the abort timer is meant to scale with the 4 MiB chunk being
 * fetched, with a 30 second floor. The call site substituted the whole file size
 * for every non-final chunk, so a stalled CDN connection on a 1 GB file held the
 * backup for ~68 minutes instead of ~30 seconds before aborting and retrying.
 *
 * The armed delay is the observable under test, so these capture what the code
 * hands to setTimeout rather than waiting out real time.
 */
const FLOOR_MS = 30_000;

function capture_armed_delays(): number[] {
  const delays: number[] = [];
  const real_set_timeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return real_set_timeout(fn, ms);
  }) as typeof globalThis.setTimeout;
  return delays;
}

describe('chunk download abort timeout', () => {
  let real_set_timeout: typeof globalThis.setTimeout;
  let fetch_mock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    real_set_timeout = globalThis.setTimeout;
    fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    globalThis.setTimeout = real_set_timeout;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A 206 answering exactly the requested range. */
  function range_response(range_start: number, range_end: number): Response {
    const body = Buffer.alloc(range_end - range_start + 1, 1);
    return {
      status: 206,
      headers: { get: (): string | null => null },
      arrayBuffer: () => Promise.resolve(body.buffer.slice(0, body.length)),
    } as unknown as Response;
  }

  it('arms the floor for the first chunk of a 100 MB file, not the whole-file value', async () => {
    const total = 100 * 1024 * 1024;
    fetch_mock.mockImplementation((_url: string, init: { headers: { Range: string } }) => {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      return Promise.resolve(range_response(Number(start), Number(end)));
    });

    const delays = capture_armed_delays();
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(delays[0]).toBe(FLOOR_MS);
    // The pre-fix value, kept explicit so the regression is unmistakable.
    expect(delays[0]).not.toBe(Math.ceil(total / 256));
  });

  it('never arms a whole-file budget on any chunk of a 1 GB file', async () => {
    const total = 1024 * 1024 * 1024;
    fetch_mock.mockImplementation((_url: string, init: { headers: { Range: string } }) => {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      return Promise.resolve(range_response(Number(start), Number(end)));
    });

    const delays = capture_armed_delays();
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(Math.max(...delays)).toBe(FLOOR_MS);
    expect(delays).toHaveLength(Math.ceil(total / CHUNK_SIZE_BYTES));
  });

  it('aborts a hung chunk at the floor rather than the whole-file value', async () => {
    const total = 1024 * 1024 * 1024;
    let aborted_after: number | undefined;

    fetch_mock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const armed_at = Date.now();
      init.signal.addEventListener('abort', () => {
        aborted_after = Date.now() - armed_at;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      return promise;
    });

    vi.useFakeTimers();
    try {
      const promise = download_file_chunked('https://cdn.test/file', total, 'item-1').catch(
        (e: unknown) => e,
      );
      // One tick past the floor is enough; the pre-fix budget was 4194304 ms.
      await vi.advanceTimersByTimeAsync(FLOOR_MS + 1_000);
      expect(aborted_after).toBeLessThanOrEqual(FLOOR_MS + 1_000);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms exactly the floor for a file of one chunk or less', async () => {
    const total = 1024 * 1024;
    fetch_mock.mockResolvedValue(range_response(0, total - 1));

    const delays = capture_armed_delays();
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(delays).toEqual([FLOOR_MS]);
  });

  it('sizes the trailing partial chunk from its own byte count', async () => {
    // 12.5 MB: three full 4 MiB chunks plus a 512 KiB tail.
    const total = 3 * CHUNK_SIZE_BYTES + 512 * 1024;
    fetch_mock.mockImplementation((_url: string, init: { headers: { Range: string } }) => {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
      return Promise.resolve(range_response(Number(start), Number(end)));
    });

    const delays = capture_armed_delays();
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(delays).toHaveLength(4);
    expect(delays[3]).toBe(compute_chunk_timeout_ms(512 * 1024));
    expect(delays[3]).toBe(FLOOR_MS);
  });

  it('still grants the whole-file budget when the CDN ignores Range and returns 200', async () => {
    // The reason the whole-file value was there at all: a 200 means the body is
    // the entire file, so draining it needs the file's budget, not a chunk's.
    // Arming that per response instead of per chunk is what keeps the common
    // path fast without regressing this one.
    const total = 100 * 1024 * 1024;
    const whole_file = Buffer.alloc(total, 7);

    fetch_mock.mockResolvedValue({
      status: 200,
      headers: { get: (): string | null => null },
      arrayBuffer: () => Promise.resolve(whole_file.buffer.slice(0, whole_file.length)),
    } as unknown as Response);

    const delays = capture_armed_delays();
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(delays[0]).toBe(FLOOR_MS);
    expect(delays).toContain(compute_chunk_timeout_ms(total));
  });
});
