import { afterEach, describe, expect, it, vi } from 'vitest';
import { upload_content_to_session } from '@/restore/upload-session';

/**
 * The chunk PUT retry read Retry-After with its own parser, which had no clamp: a value above
 * 2^31-1 ms overflowed `setTimeout`, which Node fires after about 1 ms. It now uses the shared
 * `parse_retry_after_ms`, which reads both RFC 9110 forms and clamps to one hour (issue #628).
 */

const UPLOAD_URL = 'https://graph.test/upload/session-retry-after';
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Answers the first PUT with a 503 carrying `retry_after`, every later PUT with 201. */
function stub_throttled_put(retry_after: string): { puts: () => number } {
  let puts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method !== 'PUT') return new Response('{}', { status: 200 });
      puts += 1;
      return puts === 1
        ? new Response('busy', { status: 503, headers: { 'Retry-After': retry_after } })
        : new Response('{}', { status: 201 });
    }),
  );
  return { puts: () => puts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upload_content_to_session Retry-After (issue #628)', () => {
  it('waits until an HTTP-date Retry-After before repeating the chunk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:27:00Z'));
    const server = stub_throttled_put('Wed, 21 Oct 2026 07:28:00 GMT');

    const upload = upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(server.puts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await upload;

    expect(server.puts()).toBe(2);
  });

  it('clamps an overflowing numeric Retry-After to an hour instead of repeating at once', async () => {
    vi.useFakeTimers();
    // 2^31 seconds, far past setTimeout's 2^31-1 ms ceiling.
    const server = stub_throttled_put('2147483648');

    const upload = upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx');
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS - 1);
    expect(server.puts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await upload;

    expect(server.puts()).toBe(2);
  });
});
