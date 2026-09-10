import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DownloadIntegrityError } from '@wisecom/atlas-drive/backup/download-integrity';
import { download_from_url } from '@/adapters/graph-onedrive-connector-stream';

/**
 * Issue #368. #338 gave the Range-chunked and large-staging paths a transfer-size check and left
 * the two buffered paths without one. A CDN or proxy answering 200 with a complete but wrong
 * body was hashed, encrypted and written with a checksum matching those wrong bytes, so backup
 * exited healthy, verify passed, and restore returned the wrong file. Undetectable after the
 * fact, which is the failure class #338 closed everywhere else.
 */

const CONTENT = Buffer.from('the real file content');

function respond(body: Buffer): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  } as unknown as Response;
}

describe('download_from_url transfer size', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a well-framed body that is not the recorded length', async () => {
    vi.mocked(fetch).mockResolvedValue(respond(Buffer.from('<html>error page</html>')));

    await expect(
      download_from_url('https://cdn.example.invalid/f', CONTENT.length, 'item-1'),
    ).rejects.toBeInstanceOf(DownloadIntegrityError);
  });

  it('refuses a truncated body', async () => {
    vi.mocked(fetch).mockResolvedValue(respond(CONTENT.subarray(0, 4)));

    await expect(
      download_from_url('https://cdn.example.invalid/f', CONTENT.length, 'item-1'),
    ).rejects.toThrow(/expected 21/);
  });

  it('accepts the body when the length matches', async () => {
    vi.mocked(fetch).mockResolvedValue(respond(CONTENT));

    await expect(
      download_from_url('https://cdn.example.invalid/f', CONTENT.length, 'item-1'),
    ).resolves.toEqual(CONTENT);
  });

  it('accepts any length when the item records no size', async () => {
    vi.mocked(fetch).mockResolvedValue(respond(CONTENT));

    await expect(download_from_url('https://cdn.example.invalid/f', 0, 'item-1')).resolves.toEqual(
      CONTENT,
    );
  });
});
