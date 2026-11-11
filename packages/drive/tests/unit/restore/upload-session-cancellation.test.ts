/**
 * Issue #682. A chunk PUT answered with a throttle slept out its Retry-After with no abort signal,
 * so Ctrl+C during a large-file restore waited up to an hour. The upload session the cancelled
 * upload leaves behind must be released, never completed into a partial file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { SESSION_CLEANUP_TIMEOUT_MS, upload_content_to_session } from '@/restore/upload-session';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const UPLOAD_URL = 'https://graph.test/upload/session-cancel';

/** Answers every chunk PUT with `429 Retry-After: 360` and records each request's method. */
function stub_throttled_session(): string[] {
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string }) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'PUT') {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '360' } });
      }
      return new Response(null, { status: 204 });
    }),
  );
  return methods;
}

describe('upload_content_to_session cancelled during a chunk Retry-After (issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ends the wait within a second and deletes the session instead of committing it', async () => {
    const methods = stub_throttled_session();
    const controller = new AbortController();
    let settled = false;

    const upload = run_with_abort_signal(controller.signal, () =>
      upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx'),
    ).finally(() => (settled = true));
    const outcome = upload.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(methods).toEqual(['PUT', 'DELETE']);
  });

  it('lets a committing chunk already in flight finish, so a written file is not reported cancelled', async () => {
    const methods: string[] = [];
    // A PUT that Graph answers after 3 s, and that honours its signal the way fetch does.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string; signal?: AbortSignal }) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method !== 'PUT') return Promise.resolve(new Response(null, { status: 204 }));
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('{}', { status: 201 })), 3_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        });
      }),
    );
    const controller = new AbortController();

    const upload = run_with_abort_signal(controller.signal, () =>
      upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx'),
    );
    const outcome = upload.then(
      () => 'completed',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await outcome).toBe('completed');
    expect(methods).toEqual(['PUT']);
  });

  it('bounds the cleanup DELETE, so an unresponsive endpoint cannot hold back the interrupted result', async () => {
    const methods: string[] = [];
    // Throttles every PUT; the DELETE never answers unless its own signal fires.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { method?: string; signal?: AbortSignal }) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'PUT') {
          return Promise.resolve(
            new Response('slow down', { status: 429, headers: { 'Retry-After': '360' } }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }),
    );
    const controller = new AbortController();
    let settled = false;

    const upload = run_with_abort_signal(controller.signal, () =>
      upload_content_to_session(UPLOAD_URL, Buffer.alloc(16, 1), 'Report.docx'),
    ).finally(() => (settled = true));
    const outcome = upload.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(SESSION_CLEANUP_TIMEOUT_MS + 1_000);

    expect(settled).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(methods).toEqual(['PUT', 'DELETE']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not cancel the upload session after a cancelled run'),
    );
  });
});
