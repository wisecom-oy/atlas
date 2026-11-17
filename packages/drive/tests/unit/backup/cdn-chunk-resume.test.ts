import { afterEach, describe, expect, it, vi } from 'vitest';
import { create_cdn_chunk_downloader } from '@/backup/cdn-chunk-download';
import { CHUNK_SIZE_BYTES } from '@/backup/cdn-chunk-request';
import { range_response } from './cdn-chunk.fixtures';

// Issue #718: a download whose URL expired resumes at the failed chunk, not at byte zero.

const URL = 'https://cdn.test/item';
const { fetch_file_chunks } = create_cdn_chunk_downloader('onedrive');

async function collect(parts: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of parts) chunks.push(chunk);
  return Buffer.concat(chunks);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetch_file_chunks resume offset (issue #718)', () => {
  it('requests the Range from the resume offset and yields only the remaining chunks', async () => {
    const total = 2 * CHUNK_SIZE_BYTES;
    const second = Buffer.alloc(CHUNK_SIZE_BYTES, 2);
    const fetch_mock = vi.fn().mockResolvedValueOnce(range_response(206, second, CHUNK_SIZE_BYTES));
    vi.stubGlobal('fetch', fetch_mock);

    const body = await collect(
      fetch_file_chunks(URL, total, 'item-1', undefined, CHUNK_SIZE_BYTES),
    );

    expect(fetch_mock).toHaveBeenCalledTimes(1);
    expect(fetch_mock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Range: `bytes=${CHUNK_SIZE_BYTES}-${total - 1}` },
    });
    expect(body.equals(second)).toBe(true);
  });

  it('starts at byte zero when no offset is given', async () => {
    const first = Buffer.alloc(CHUNK_SIZE_BYTES, 1);
    const fetch_mock = vi.fn().mockResolvedValueOnce(range_response(206, first, 0));
    vi.stubGlobal('fetch', fetch_mock);

    await collect(fetch_file_chunks(URL, CHUNK_SIZE_BYTES, 'item-1'));

    expect(fetch_mock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Range: `bytes=0-${CHUNK_SIZE_BYTES - 1}` },
    });
  });

  it('fails a resumed download whose Range is ignored, rather than restarting the file', async () => {
    const total = 2 * CHUNK_SIZE_BYTES;
    // A 200 with the whole file: the server ignored Range. Restarting at byte zero here would feed
    // the cipher bytes that were already uploaded.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(range_response(200, Buffer.alloc(total))));

    await expect(
      collect(fetch_file_chunks(URL, total, 'item-1', undefined, CHUNK_SIZE_BYTES)),
    ).rejects.toThrow(/Range requests stopped being honoured/);
  });

  it('refuses an offset that is not on a chunk boundary', async () => {
    await expect(
      collect(fetch_file_chunks(URL, 2 * CHUNK_SIZE_BYTES, 'item-1', undefined, 1)),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
