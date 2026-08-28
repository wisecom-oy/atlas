import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_SIZE_BYTES,
  compute_chunk_timeout_ms,
  download_file_chunked,
} from '@/adapters/graph-onedrive-chunked-download';

/**
 * Issue #198 was filed against SharePoint, but this file carried the identical
 * call site, so it had the identical defect: every non-final chunk armed its
 * abort timer from the whole file size. Fixed in both; guarded in both, because
 * the two copies have already drifted into the same bug once.
 *
 * The full behaviour matrix lives in the SharePoint suite. This covers the
 * invariant that regressed.
 */
const FLOOR_MS = 30_000;

describe('chunk download abort timeout', () => {
  let real_set_timeout: typeof globalThis.setTimeout;
  let fetch_mock: ReturnType<typeof vi.fn>;
  let delays: number[];

  beforeEach(() => {
    real_set_timeout = globalThis.setTimeout;
    delays = [];
    fetch_mock = vi
      .fn()
      .mockImplementation((_url: string, init: { headers: { Range: string } }) => {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
        const body = Buffer.alloc(Number(end) - Number(start) + 1, 1);
        return Promise.resolve({
          status: 206,
          headers: { get: (): string | null => null },
          arrayBuffer: () => Promise.resolve(body.buffer.slice(0, body.length)),
        } as unknown as Response);
      });
    vi.stubGlobal('fetch', fetch_mock);

    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real_set_timeout(fn, ms);
    }) as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = real_set_timeout;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('arms the floor for every chunk of a 100 MB file, not the whole-file value', async () => {
    const total = 100 * 1024 * 1024;
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(delays[0]).toBe(FLOOR_MS);
    expect(delays[0]).not.toBe(Math.ceil(total / 256));
    expect(delays).toHaveLength(Math.ceil(total / CHUNK_SIZE_BYTES));
    expect(Math.max(...delays)).toBe(FLOOR_MS);
  });

  it('sizes the trailing partial chunk from its own byte count', async () => {
    const total = 3 * CHUNK_SIZE_BYTES + 512 * 1024;
    await download_file_chunked('https://cdn.test/file', total, 'item-1');

    expect(delays).toHaveLength(4);
    expect(delays[3]).toBe(compute_chunk_timeout_ms(512 * 1024));
  });
});
