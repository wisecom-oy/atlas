/**
 * Issue #892. The final chunk of a OneDrive or SharePoint upload session creates the file, and it
 * was retried on a 500, 502, 503 or 504 like any other chunk, then reported as a plain failure.
 * Microsoft 365 may have created the file by then, so a rerun under `--conflict rename` left a
 * second copy beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import { upload_content_to_session } from '@/restore/upload-session';
import {
  FIRST_RANGE,
  LAST_RANGE,
  TWO_CHUNKS,
  puts_of,
  settle_after,
  stub_upload_host,
} from './upload-session-host.fixtures';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const UPLOAD_URL = 'https://graph.test/upload/session-commit';
const ACCEPTED = (): Response => new Response('{}', { status: 202 });

/** Uploads `TWO_CHUNKS` and settles once the retries could have run. */
function upload(): Promise<unknown> {
  return settle_after(upload_content_to_session(UPLOAD_URL, TWO_CHUNKS, 'Report.docx'), 600_000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('upload_content_to_session when the final chunk ends ambiguously (issue #892)', () => {
  it('sends a final chunk answered 504 once, so the 416 a re-send would get is never asked for', async () => {
    const requests = stub_upload_host([
      ACCEPTED(),
      new Response('gateway', { status: 504 }),
      new Response('{"error":{"code":"invalidRange"}}', { status: 416 }),
    ]);

    const outcome = await upload();

    expect(outcome).toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toBe(
      `outcome unknown, the file may exist: the final upload chunk (${LAST_RANGE}) ended with ` +
        'HTTP 504 -- gateway after Microsoft 365 may have committed it. ' +
        'Check the target before restoring it again',
    );
    expect(puts_of(requests)).toEqual([FIRST_RANGE, LAST_RANGE]);
  });

  it.each([500, 502])('reports a final chunk answered %i as an unknown outcome', async (status) => {
    const requests = stub_upload_host([ACCEPTED(), new Response('', { status })]);

    expect(await upload()).toBeInstanceOf(UploadCommitUnknownError);
    expect(puts_of(requests)).toHaveLength(2);
  });

  it('reports a 503 without Retry-After as an unknown outcome', async () => {
    const requests = stub_upload_host([ACCEPTED(), new Response('', { status: 503 })]);

    expect(await upload()).toBeInstanceOf(UploadCommitUnknownError);
    expect(puts_of(requests)).toHaveLength(2);
  });

  it('sends the final chunk again after a 503 with Retry-After, and reports a 416 then as unknown', async () => {
    const requests = stub_upload_host([
      ACCEPTED(),
      new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }),
      new Response('overlap', { status: 416 }),
    ]);

    expect(await upload()).toBeInstanceOf(UploadCommitUnknownError);
    expect(puts_of(requests)).toEqual([FIRST_RANGE, LAST_RANGE, LAST_RANGE]);
  });

  it('completes the file when the final chunk lands after a 429', async () => {
    const requests = stub_upload_host([
      ACCEPTED(),
      new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }),
      new Response('{"id":"item-1"}', { status: 201 }),
    ]);

    expect(await upload()).toBe('item-1');
    expect(puts_of(requests)).toEqual([FIRST_RANGE, LAST_RANGE, LAST_RANGE]);
  });

  it('names the outcome in the session cleanup warning', async () => {
    stub_upload_host([ACCEPTED(), new Response('', { status: 504 })], () => {
      return new Response('{"error":{"code":"itemNotFound"}}', { status: 404 });
    });

    await upload();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('after a final chunk with an unknown outcome: HTTP 404'),
    );
  });
});

describe('upload_content_to_session when a chunk is refused (issue #892)', () => {
  it('reports a 4xx on the first send of the final chunk as a plain failure', async () => {
    const requests = stub_upload_host([ACCEPTED(), new Response('bad', { status: 400 })]);

    const outcome = await upload();

    expect(outcome).not.toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toBe(
      `Resumable upload failed at range ${LAST_RANGE}: HTTP 400 bad`,
    );
    expect(puts_of(requests)).toHaveLength(2);
  });

  it('reports an intermediate chunk that kept failing as a plain failure', async () => {
    stub_upload_host([
      new Response('', { status: 504 }),
      new Response('', { status: 504 }),
      new Response('', { status: 504 }),
    ]);

    const outcome = await upload();

    expect(outcome).not.toBeInstanceOf(UploadCommitUnknownError);
    expect((outcome as Error).message).toBe(
      `Resumable upload failed at range ${FIRST_RANGE}: HTTP 504 `,
    );
  });
});
