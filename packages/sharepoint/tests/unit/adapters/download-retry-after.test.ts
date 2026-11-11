import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';

/**
 * Issue #628: `download_from_url` parsed Retry-After with its own `parseInt` copy. An HTTP-date
 * became NaN and fell back to the default backoff, and a value above 2^31-1 ms overflowed
 * `setTimeout`, which Node fires after about 1 ms. It now uses the shared parser, which reads both
 * forms and clamps to one hour.
 */

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { download_with_fallback } = await import('@/adapters/graph-sharepoint-download-executor');

const URL = 'https://cdn.example.invalid/file';
const BODY = Buffer.from('url-download');
const ONE_HOUR_MS = 60 * 60 * 1000;

function make_item(): SharePointDeltaItem {
  return {
    drive_id: 'drive-1',
    item_id: 'item-1',
    kind: 'file',
    file_name: 'report.bin',
    parent_path: '/',
    size_bytes: BODY.length,
    deleted: false,
    download_url: URL,
  };
}

/** No Graph call is expected: the URL is on the item and the second attempt succeeds. */
const CLIENT = { api: vi.fn() } as unknown as Client;

function throttled(retry_after: string): Response {
  return new Response(null, { status: 429, headers: { 'Retry-After': retry_after } });
}

describe('SharePoint URL download Retry-After (issue #628)', () => {
  let fetch_mock: Mock;

  beforeEach(() => {
    vi.useFakeTimers();
    fetch_mock = vi.fn();
    vi.stubGlobal('fetch', fetch_mock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits until an HTTP-date Retry-After instead of the default backoff', async () => {
    vi.setSystemTime(new Date('2026-10-21T07:27:00Z'));
    fetch_mock
      .mockResolvedValueOnce(throttled('Wed, 21 Oct 2026 07:28:00 GMT'))
      .mockResolvedValueOnce(new Response(BODY));

    const promise = download_with_fallback(CLIENT, make_item());
    // The default backoff for the first retry is 1 second; the date asks for 60.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual(BODY);
    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it('clamps an overflowing numeric Retry-After to an hour instead of retrying at once', async () => {
    // 2^31 seconds, far past setTimeout's 2^31-1 ms ceiling.
    fetch_mock
      .mockResolvedValueOnce(throttled('2147483648'))
      .mockResolvedValueOnce(new Response(BODY));

    const promise = download_with_fallback(CLIENT, make_item());
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS - 1);
    expect(fetch_mock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual(BODY);
  });

  it('ends a Retry-After wait as soon as the run is cancelled', async () => {
    fetch_mock.mockResolvedValue(throttled('3600'));
    const cancel = new AbortController();

    const outcome = download_with_fallback(CLIENT, make_item(), cancel.signal).catch(
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    cancel.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(0);

    expect(((await outcome) as Error).message).toBe('Run interrupted by Ctrl+C');
    expect(fetch_mock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
