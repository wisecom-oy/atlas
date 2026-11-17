import { describe, expect, it, vi, type Mock } from 'vitest';
import { DownloadRefusedError } from '@wisecom/atlas-m365-graph';
import type { DriveDeltaItem } from '@/drive-ports';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import type { DriveLargeFileDeps } from '@/backup/large-file-pipeline';
import {
  DownloadUrlExpiredError,
  MAX_URL_REFRESHES_WITHOUT_PROGRESS,
  is_download_url_expired,
  stream_chunks_with_url_refresh,
} from '@/backup/large-file-url-refresh';

// Issue #718: a 401 or 403 from the CDN on a large file re-resolves the URL and resumes at the
// failed range. The fetch is scripted per URL: each URL answers normally until it reaches the
// byte offset it expires at, and every chunk it does answer is the real slice of the payload.

const CHUNKS = 5;
const TOTAL = CHUNKS * CHUNK_SIZE_BYTES;
const PAYLOAD = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) PAYLOAD[i] = i % 251;

const ITEM: DriveDeltaItem = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  kind: 'file',
  file_name: 'movie.mp4',
  parent_path: '/Videos',
  size_bytes: TOTAL,
  deleted: false,
} as DriveDeltaItem;

type Fetch = DriveLargeFileDeps['fetch_chunks'];
type ResolveFn = (item: DriveDeltaItem) => Promise<string | undefined>;

/** A CDN refusal of a stale URL, shaped as the chunk downloader throws it after its retries. */
function expired_chunk_error(status = 403): ChunkDownloadError {
  const cause = new CdnHttpError(`HTTP ${status} for chunk`, status);
  return new ChunkDownloadError(`Failed chunk after 1 attempts: HTTP ${status}`, cause);
}

/**
 * A fetch where each URL serves chunks until it reaches its expiry offset (`expires_at`), then
 * throws the 403 a stale URL gets. A URL missing from the map never expires.
 */
function scripted_fetch(expires_at: Record<string, number>): {
  fetch_chunks: Fetch;
  calls: Array<{ url: string; start: number }>;
} {
  const calls: Array<{ url: string; start: number }> = [];
  const fetch_chunks: Fetch = async function* (url, total, _item_id, _signal, start_offset = 0) {
    calls.push({ url, start: start_offset });
    const expiry = expires_at[url] ?? Number.POSITIVE_INFINITY;
    for (let offset = start_offset; offset < total; offset += CHUNK_SIZE_BYTES) {
      if (offset >= expiry) throw expired_chunk_error();
      yield PAYLOAD.subarray(offset, Math.min(offset + CHUNK_SIZE_BYTES, total));
    }
  };
  return { fetch_chunks, calls };
}

/** A connector whose re-resolve hands out `urls` in order, then nothing. */
function resolver(urls: string[]): { resolve_download_url: Mock<ResolveFn> } {
  const queue = [...urls];
  return {
    resolve_download_url: vi.fn<ResolveFn>(async () => queue.shift()),
  };
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

describe('stream_chunks_with_url_refresh', () => {
  it('re-resolves when the first range is refused and downloads the whole file', async () => {
    const { fetch_chunks, calls } = scripted_fetch({ stale: 0 });
    const connector = resolver(['fresh']);

    const body = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'stale'),
    );

    expect(body.equals(PAYLOAD)).toBe(true);
    expect(connector.resolve_download_url).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { url: 'stale', start: 0 },
      { url: 'fresh', start: 0 },
    ]);
  });

  it('resumes at the failed range when the URL expires in the middle of the file', async () => {
    const { fetch_chunks, calls } = scripted_fetch({ stale: 2 * CHUNK_SIZE_BYTES });
    const connector = resolver(['fresh']);

    const body = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'stale'),
    );

    // The first two chunks were already handed on; the retry starts at the third, not at byte zero.
    expect(body.equals(PAYLOAD)).toBe(true);
    expect(calls).toEqual([
      { url: 'stale', start: 0 },
      { url: 'fresh', start: 2 * CHUNK_SIZE_BYTES },
    ]);
  });

  it('keeps refreshing across a transfer that outlives many URLs, as long as each one makes progress', async () => {
    // Each URL gets exactly one chunk further than the one before it, so no refresh is wasted.
    const expires_at: Record<string, number> = {
      u0: 1 * CHUNK_SIZE_BYTES,
      u1: 2 * CHUNK_SIZE_BYTES,
      u2: 3 * CHUNK_SIZE_BYTES,
      u3: 4 * CHUNK_SIZE_BYTES,
    };
    const { fetch_chunks, calls } = scripted_fetch(expires_at);
    const connector = resolver(['u1', 'u2', 'u3', 'u4']);

    const body = await collect(stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'u0'));

    // Four refreshes is more than the budget of a stalled file, which proves the budget is per stall.
    expect(connector.resolve_download_url).toHaveBeenCalledTimes(4);
    expect(body.equals(PAYLOAD)).toBe(true);
    expect(calls.map((call) => call.start)).toEqual([
      0,
      CHUNK_SIZE_BYTES,
      2 * CHUNK_SIZE_BYTES,
      3 * CHUNK_SIZE_BYTES,
      4 * CHUNK_SIZE_BYTES,
    ]);
  });

  it('stops after the stall budget when every refreshed URL is refused at the same offset', async () => {
    const { fetch_chunks, calls } = scripted_fetch({
      u0: 0,
      u1: 0,
      u2: 0,
      u3: 0,
      u4: 0,
    });
    const connector = resolver(['u1', 'u2', 'u3', 'u4']);

    const error = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'u0'),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DownloadUrlExpiredError);
    expect(is_download_url_expired(error)).toBe(true);
    expect(connector.resolve_download_url).toHaveBeenCalledTimes(
      MAX_URL_REFRESHES_WITHOUT_PROGRESS,
    );
    expect(calls).toHaveLength(MAX_URL_REFRESHES_WITHOUT_PROGRESS + 1);
  });

  it('rethrows a Graph refusal from the re-resolve instead of retrying it', async () => {
    const { fetch_chunks, calls } = scripted_fetch({ stale: 0 });
    const refusal = new DownloadRefusedError('refused by policy', 'notAllowed');
    const connector = {
      resolve_download_url: vi.fn<ResolveFn>().mockRejectedValue(refusal),
    };

    const error = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'stale'),
    ).catch((err: unknown) => err);

    expect(error).toBe(refusal);
    expect(calls).toHaveLength(1);
  });

  it('does not refresh for a failure that is not an expired URL', async () => {
    const not_found = new ChunkDownloadError('Failed chunk: HTTP 404', new CdnHttpError('x', 404));
    const fetch_chunks: Fetch = async function* () {
      yield* [];
      throw not_found;
    };
    const connector = resolver(['fresh']);

    const error = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'stale'),
    ).catch((err: unknown) => err);

    expect(error).toBe(not_found);
    expect(connector.resolve_download_url).not.toHaveBeenCalled();
  });

  it('does not refresh once the run is cancelled', async () => {
    const { fetch_chunks } = scripted_fetch({ stale: 0 });
    const connector = resolver(['fresh']);
    const cancel = new AbortController();
    cancel.abort(new Error('cancelled'));

    const error = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'stale', cancel.signal),
    ).catch((err: unknown) => err);

    expect(error).toEqual(new Error('cancelled'));
    expect(connector.resolve_download_url).not.toHaveBeenCalled();
  });

  it('fails without a refresh when the re-resolve returns no URL', async () => {
    const { fetch_chunks } = scripted_fetch({ stale: 0 });
    const connector = resolver([]);

    const error = await collect(
      stream_chunks_with_url_refresh(fetch_chunks, connector, ITEM, 'stale'),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChunkDownloadError);
    expect(is_download_url_expired(error)).toBe(false);
  });
});
