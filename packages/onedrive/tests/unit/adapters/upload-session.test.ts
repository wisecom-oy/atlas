import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  upload_content_to_session,
  LARGE_UPLOAD_CHUNK,
} from '@wisecom/atlas-drive/restore/upload-session';

/**
 * Issue #342: the chunk loop returned on any `response.ok`, so a session that answered every PUT
 * with `202 Accepted` and a list of ranges it still wanted was reported as a restored file. A
 * thrown network error also bypassed the DELETE that releases the session.
 */

const UPLOAD_URL = 'https://graph.test/upload/session-1';
const TWO_CHUNKS = Buffer.alloc(LARGE_UPLOAD_CHUNK + 1024, 7);

interface Call {
  readonly method: string;
  readonly range: string | undefined;
}

/** Records every request and answers PUTs from the supplied status sequence. */
function stub_session(statuses: number[], throw_on_put?: number): Call[] {
  const calls: Call[] = [];
  let put_index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, range: init?.headers?.['Content-Range'] });
      if (method !== 'PUT') return new Response('{"nextExpectedRanges":["0-"]}', { status: 200 });
      const index = put_index++;
      if (throw_on_put === index) throw new Error('socket hang up');
      return new Response('{}', { status: statuses[index] ?? 202 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upload_content_to_session (issue #342)', () => {
  it('returns once the last chunk is answered with a terminal 201', async () => {
    const calls = stub_session([202, 201]);

    await expect(upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx')).resolves.toBe(
      undefined,
    );

    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('fails the file when the last chunk is still answered with 202', async () => {
    const calls = stub_session([202, 202]);

    await expect(upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx')).rejects.toThrow(
      /sent every byte but Graph never returned a completed item; it still expects 0-/,
    );

    // Every byte went out, so this is not a transfer failure: the session simply never converged.
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('releases the session when the last chunk throws', async () => {
    const calls = stub_session([202, 200], 1);

    await expect(upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx')).rejects.toThrow(
      'socket hang up',
    );

    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('fails an item Graph completes before every byte was sent', async () => {
    const calls = stub_session([201, 201]);

    await expect(upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx')).rejects.toThrow(
      /completed at bytes 0-10485759\/10486784 with 1024 byte\(s\) unsent/,
    );

    // Graph removed the session when it returned the item, so a DELETE would only 404 and log that
    // the session stays reserved.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('reports a cleanup that itself failed rather than hiding it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === 'DELETE') return new Response('', { status: 500 });
        if (init?.method === 'PUT') return new Response('{}', { status: 202 });
        return new Response('{"nextExpectedRanges":["0-"]}', { status: 200 });
      }),
    );

    await expect(
      upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx'),
    ).rejects.toThrow(/never returned a completed item/);

    expect(warn).toHaveBeenCalled();
  });
});
