import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { classify_download_failure } from '@wisecom/atlas-m365-graph';
import { CdnHttpError } from '@/backup/cdn-chunk-errors';
import { DownloadIntegrityError } from '@/backup/download-integrity';
import { download_from_url, MAX_URL_RETRIES } from '@/backup/cdn-url-download';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const URL_ADDRESS = 'https://cdn.example.invalid/file';
const CONTENT = Buffer.from('the real file content');

/** Minimal fetch Response stand-in: only the fields the URL download reads. */
function respond(status: number, body = CONTENT, retry_after?: string): Response {
  const headers = new Headers();
  if (retry_after !== undefined) headers.set('Retry-After', retry_after);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  } as unknown as Response;
}

function download(size_bytes = CONTENT.length, abort_signal?: AbortSignal): Promise<Buffer> {
  return download_from_url('OneDrive', URL_ADDRESS, size_bytes, 'item-1', abort_signal);
}

describe('download_from_url', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Issue #675: the OneDrive copy threw a plain Error, which classified as `unclassified`, so a
  // stale URL was never re-resolved.
  it.each([401, 403])(
    'throws CdnHttpError %i, which classifies as an expired URL',
    async (status) => {
      fetch_mock.mockResolvedValue(respond(status));

      const error = await download().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(CdnHttpError);
      expect((error as CdnHttpError).status_code).toBe(status);
      expect((error as Error).message).toBe(
        `Failed to download OneDrive file item-1: HTTP ${status}`,
      );
      expect(classify_download_failure(error)).toBe('expired_url');
      expect(fetch_mock).toHaveBeenCalledOnce();
    },
  );

  it('retries a 429 after its Retry-After and returns the body', async () => {
    vi.useFakeTimers();
    fetch_mock
      .mockResolvedValueOnce(respond(429, CONTENT, '3'))
      .mockResolvedValueOnce(respond(200));

    const pending = download();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch_mock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual(CONTENT);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it('throws CdnHttpError 429 with the Retry-After once the retries are spent', async () => {
    fetch_mock.mockResolvedValue(respond(429, CONTENT, '0'));

    const error = await download().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CdnHttpError);
    expect((error as CdnHttpError).status_code).toBe(429);
    expect((error as CdnHttpError).retry_after_ms).toBe(0);
    expect(fetch_mock).toHaveBeenCalledTimes(MAX_URL_RETRIES + 1);
  });

  it('stops waiting out a 429 when the run is cancelled', async () => {
    fetch_mock.mockResolvedValue(respond(429, CONTENT, '3600'));
    const cancel = new AbortController();

    const outcome = download(CONTENT.length, cancel.signal).catch((err: unknown) => err);
    await vi.waitFor(() => expect(fetch_mock).toHaveBeenCalledOnce());
    cancel.abort(new Error('cancelled'));

    expect(await outcome).toEqual(new Error('cancelled'));
    expect(fetch_mock).toHaveBeenCalledOnce();
  });

  // CodeRabbit on #677: undici holds the connection until an unread body is cancelled.
  it('cancels the unread body of a 429 and of a refused response', async () => {
    const cancels: Mock[] = [];
    const with_body = (response: Response): Response => {
      const cancel = vi.fn(() => Promise.reject(new Error('already closed')));
      cancels.push(cancel);
      return { ...response, body: { cancel } } as unknown as Response;
    };
    fetch_mock
      .mockResolvedValueOnce(with_body(respond(429, CONTENT, '0')))
      .mockResolvedValueOnce(with_body(respond(403)));

    await expect(download()).rejects.toBeInstanceOf(CdnHttpError);
    expect(cancels).toHaveLength(2);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
  });

  // Issue #368: a well-framed 200 with the wrong body must never be stored.
  it('refuses a well-framed body that is not the recorded length', async () => {
    fetch_mock.mockResolvedValue(respond(200, Buffer.from('<html>error page</html>')));

    await expect(download()).rejects.toBeInstanceOf(DownloadIntegrityError);
  });

  it('refuses a truncated body', async () => {
    fetch_mock.mockResolvedValue(respond(200, CONTENT.subarray(0, 4)));

    await expect(download()).rejects.toThrow(/expected 21/);
  });

  it('accepts any length when the item records no size', async () => {
    fetch_mock.mockResolvedValue(respond(200));

    await expect(download(0)).resolves.toEqual(CONTENT);
  });
});
