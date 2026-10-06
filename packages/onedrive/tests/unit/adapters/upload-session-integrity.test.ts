import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LARGE_UPLOAD_CHUNK,
  upload_content_to_session,
} from '@wisecom/atlas-drive/restore/upload-session';

const UPLOAD_URL = 'https://graph.test/upload/session-1';

interface Call {
  readonly method: string;
  readonly range: string | undefined;
}

type Answer = { readonly status: number; readonly retry_after?: string };

/** Records every request and answers chunk PUTs from `answers`, in order. */
function stub_session(answers: Answer[]): Call[] {
  const calls: Call[] = [];
  let put = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, range: init?.headers?.['Content-Range'] });
      if (method !== 'PUT') return new Response('{}', { status: 204 });
      const answer = answers[put++] ?? { status: 500 };
      const headers: Record<string, string> = answer.retry_after
        ? { 'retry-after': answer.retry_after }
        : {};
      return new Response('{}', { status: answer.status, headers });
    }),
  );
  return calls;
}

/** A streamed source that yields `chunks` but declares `total_bytes`, as a manifest would. */
function streamed(
  total_bytes: number,
  ...chunks: Buffer[]
): { chunks: Buffer[]; total_bytes: number } {
  return { chunks, total_bytes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('upload_content_to_session integrity', () => {
  it('refuses a source shorter than the manifest and releases the session', async () => {
    // How a truncated restore presents: the stream ends cleanly, short of the recorded size.
    const calls = stub_session([{ status: 201 }]);

    await expect(
      upload_content_to_session(UPLOAD_URL, streamed(2048, Buffer.alloc(1000)), 'report.docx'),
    ).rejects.toThrow('verified 1000 byte(s), but the manifest recorded 2048');

    expect(calls.filter((call) => call.method === 'PUT')).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(['DELETE']);
  });

  it('refuses a multi-chunk source that ends short, after the full chunks were sent', async () => {
    const declared = LARGE_UPLOAD_CHUNK * 3;
    const calls = stub_session([{ status: 202 }]);

    await expect(
      upload_content_to_session(
        UPLOAD_URL,
        streamed(declared, Buffer.alloc(LARGE_UPLOAD_CHUNK + 1)),
        'big.zip',
      ),
    ).rejects.toThrow(
      `verified ${LARGE_UPLOAD_CHUNK + 1} byte(s), but the manifest recorded ${declared}`,
    );

    // The committing chunk is never sent, so Graph cannot assemble a short item.
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  it('replays the same range after a transient 5xx, waiting one second without Retry-After', async () => {
    vi.useFakeTimers();
    const calls = stub_session([{ status: 503 }, { status: 201 }]);

    const upload = upload_content_to_session(UPLOAD_URL, Buffer.alloc(100), 'a.bin');
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await upload;

    expect(calls.map((call) => [call.method, call.range])).toEqual([
      ['PUT', 'bytes 0-99/100'],
      ['PUT', 'bytes 0-99/100'],
    ]);
  });

  it('waits as long as Retry-After asks before replaying the chunk', async () => {
    vi.useFakeTimers();
    const calls = stub_session([{ status: 502, retry_after: '3' }, { status: 200 }]);

    const upload = upload_content_to_session(UPLOAD_URL, Buffer.alloc(100), 'a.bin');
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await upload;

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
  });

  it('gives up after three transient failures and releases the session', async () => {
    vi.useFakeTimers();
    const calls = stub_session([{ status: 500 }, { status: 500 }, { status: 500 }]);

    const upload = upload_content_to_session(UPLOAD_URL, Buffer.alloc(100), 'a.bin');
    const outcome = expect(upload).rejects.toThrow(
      'Resumable upload failed at range bytes 0-99/100: HTTP 500',
    );
    await vi.advanceTimersByTimeAsync(2000);
    await outcome;

    expect(calls.map((call) => call.method)).toEqual(['PUT', 'PUT', 'PUT', 'DELETE']);
  });

  it('does not retry a chunk Graph rejected outright', async () => {
    const calls = stub_session([{ status: 400 }]);

    await expect(upload_content_to_session(UPLOAD_URL, Buffer.alloc(100), 'a.bin')).rejects.toThrow(
      'HTTP 400',
    );
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'DELETE']);
  });
});
