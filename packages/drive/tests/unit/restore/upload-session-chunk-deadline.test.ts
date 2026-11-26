/**
 * Issue #878. A chunk PUT ran with no deadline of its own, so a host that accepted it and never
 * answered held the file for undici's 300 s header timeout, and a reset or other transport failure
 * failed the whole file on the first attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upload_chunk_timeout_ms } from '@wisecom/atlas-m365-graph';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import {
  LARGE_UPLOAD_CHUNK,
  SESSION_CLEANUP_TIMEOUT_MS,
  upload_content_to_session,
} from '@/restore/upload-session';
import {
  FIRST_RANGE,
  HANG,
  LAST_RANGE,
  TWO_CHUNKS,
  connection_reset,
  puts_of,
  settle_after,
  stub_upload_host,
} from './upload-session-host.fixtures';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const UPLOAD_URL = 'https://graph.test/upload/session-deadline';
/** About 82 s: the deadline of one 10 MiB chunk PUT. */
const CHUNK_DEADLINE_MS = upload_chunk_timeout_ms(LARGE_UPLOAD_CHUNK);
/** 60 s: the deadline of the 100-byte final chunk of `TWO_CHUNKS`. */
const FINAL_DEADLINE_MS = upload_chunk_timeout_ms(100);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upload_content_to_session on an intermediate chunk (issue #878)', () => {
  it('aborts a hanging PUT at its deadline and sends the chunk again', async () => {
    const requests = stub_upload_host([
      HANG,
      new Response('{}', { status: 202 }),
      new Response('{"id":"item-1"}', { status: 201 }),
    ]);

    const upload = upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx');
    await vi.advanceTimersByTimeAsync(CHUNK_DEADLINE_MS - 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(false);

    const outcome = await settle_after(upload, 2_000);

    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(outcome).toBe('item-1');
    expect(puts_of(requests)).toEqual([FIRST_RANGE, FIRST_RANGE, LAST_RANGE]);
  });

  it('sends a chunk whose connection reset again, within the 3 attempts', async () => {
    const requests = stub_upload_host([
      connection_reset(),
      new Response('{}', { status: 202 }),
      new Response('{"id":"item-1"}', { status: 201 }),
    ]);

    const outcome = await settle_after(
      upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      2_000,
    );

    expect(outcome).toBe('item-1');
    expect(puts_of(requests)).toEqual([FIRST_RANGE, FIRST_RANGE, LAST_RANGE]);
  });

  it('fails the file after 3 resets and releases the session', async () => {
    const requests = stub_upload_host([connection_reset(), connection_reset(), connection_reset()]);

    const outcome = await settle_after(
      upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      5_000,
    );

    expect(outcome).not.toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toMatch(
      new RegExp(`failed at range ${FIRST_RANGE} after 3 attempt\\(s\\): .*connection failed`),
    );
    expect(requests.map((request) => request.method)).toEqual(['PUT', 'PUT', 'PUT', 'DELETE']);
  });

  it('does not send a chunk again after a 4xx other than 408 or 429', async () => {
    const requests = stub_upload_host([new Response('gone', { status: 404 })]);

    const outcome = await settle_after(
      upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      5_000,
    );

    expect((outcome as Error).message).toBe(
      `Resumable upload failed at range ${FIRST_RANGE}: HTTP 404 gone`,
    );
    expect(requests.map((request) => request.method)).toEqual(['PUT', 'DELETE']);
  });
});

describe('upload_content_to_session on the final chunk (issues #878, #892)', () => {
  it('aborts a hanging final PUT at its deadline, without sending it again', async () => {
    const requests = stub_upload_host([new Response('{}', { status: 202 }), HANG]);

    const outcome = await settle_after(
      upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      FINAL_DEADLINE_MS + 1_000,
    );

    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
    expect(puts_of(requests)).toEqual([FIRST_RANGE, LAST_RANGE]);
    expect(requests[1]?.signal?.aborted).toBe(true);
    expect(requests.at(-1)?.method).toBe('DELETE');
  });

  it('reports a final PUT whose connection reset as an unknown outcome, sent once', async () => {
    const requests = stub_upload_host([new Response('{}', { status: 202 }), connection_reset()]);

    const outcome = await settle_after(
      upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      5_000,
    );

    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toContain('connection failed');
    expect(puts_of(requests)).toEqual([FIRST_RANGE, LAST_RANGE]);
  });

  it('returns control within the deadline when Ctrl+C lands while the final PUT hangs', async () => {
    const requests = stub_upload_host([new Response('{}', { status: 202 }), HANG]);
    const controller = new AbortController();
    let settled = false;
    const outcome = settle_after(
      run_with_abort_signal(controller.signal, () =>
        upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      ).finally(() => (settled = true)),
      0,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(FINAL_DEADLINE_MS - 2_000);
    expect(settled).toBe(false);
    expect(requests[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(settled).toBe(true);
    expect(await outcome).toBeInstanceOf(UploadCommitUnknownError);
  });
});

describe('the status query after an incomplete upload (issue #878)', () => {
  it('gives up on a status GET that never answers after the cleanup deadline', async () => {
    const requests = stub_upload_host(
      [new Response('{}', { status: 202 }), new Response('{}', { status: 202 })],
      (method) => (method === 'GET' ? HANG : new Response(null, { status: 204 })),
    );

    const outcome = await settle_after(
      upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'),
      SESSION_CLEANUP_TIMEOUT_MS + 1_000,
    );

    expect((outcome as Error).message).toMatch(
      /sent every byte but Graph never returned a completed item; it still expects an unknown range/,
    );
    expect(requests.map((request) => request.method)).toEqual(['PUT', 'PUT', 'GET', 'DELETE']);
  });
});
