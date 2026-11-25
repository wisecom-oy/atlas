import { describe, expect, it } from 'vitest';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import { CdnHttpError, ChunkDownloadError } from '@/backup/cdn-chunk-errors';
import { DownloadIntegrityError, DownloadSizeChangedError } from '@/backup/download-integrity';
import { DownloadUrlExpiredError } from '@/backup/large-file-url-refresh';
import { TransferTimeoutError } from '@/backup/transfer-timeout';
import {
  is_transient_drive_failure,
  spares_failed_item_attempt,
  transient_download_error_for,
  TransientDownloadError,
} from '@/backup/transient-download-failure';

// Issue #857: a failure outside the file must not spend one of its five ledger attempts, or a
// Microsoft 365 incident that spans five scheduled runs leaves every file it touched permanently
// skipped. A failure that belongs to the file still spends one.

function graph_error(status: number, code = 'generalException'): Error {
  return Object.assign(new Error(`Graph ${status}`), { statusCode: status, code });
}

function socket_error(code: string): Error {
  return Object.assign(new Error('socket failure'), { code });
}

describe('is_transient_drive_failure', () => {
  it.each([
    ['an exhausted Graph retry', new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 })],
    ['an exhausted throttle', new ThrottledError('throttled', 60_000)],
    ['a Graph 503', graph_error(503)],
    ['a Graph 429', graph_error(429)],
    ['a connection reset', socket_error('ECONNRESET')],
    ['a socket timeout', socket_error('ETIMEDOUT')],
    ['a DNS failure on the download host', socket_error('ENOTFOUND')],
    ['a timed-out transfer', new TransferTimeoutError('Graph content stream timed out')],
    ['a CDN 503', new CdnHttpError('HTTP 503', 503)],
    ['a CDN 429 after its retries', new CdnHttpError('HTTP 429', 429)],
    [
      'a failed chunk carrying a CDN 502',
      new ChunkDownloadError('chunk', new CdnHttpError('', 502)),
    ],
    [
      'a failed chunk caused by a reset',
      new ChunkDownloadError('chunk', socket_error('ECONNRESET')),
    ],
    [
      'a timeout wrapped as a cause',
      new Error('wrapped', { cause: new TransferTimeoutError('t') }),
    ],
  ])('is true for %s', (_label, err) => {
    expect(is_transient_drive_failure(err)).toBe(true);
  });

  it.each([
    ['a size change', new DownloadSizeChangedError('size', 10, 9)],
    ['a wrong range', new DownloadIntegrityError('range')],
    ['a Graph 404', graph_error(404, 'itemNotFound')],
    ['a Graph 400', graph_error(400, 'invalidRequest')],
    [
      'a Graph 500 that is permanent for the item',
      graph_error(500, 'ErrorMimeContentConversionFailed'),
    ],
    ['a CDN 404', new CdnHttpError('HTTP 404', 404)],
    [
      'a failed chunk carrying a CDN 416',
      new ChunkDownloadError('chunk', new CdnHttpError('', 416)),
    ],
    ['an unrecognised Graph 403', new Error('refused', { cause: graph_error(403, 'notAllowed') })],
    ['a plain error', new Error('Range requests stopped being honoured')],
    ['a thrown string', 'boom'],
    ['a thrown null', null],
  ])('is false for %s', (_label, err) => {
    expect(is_transient_drive_failure(err)).toBe(false);
  });

  it('stops at a cyclic cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;

    expect(is_transient_drive_failure(err)).toBe(false);
  });
});

describe('transient_download_error_for', () => {
  it('wraps a transient failure and keeps it as the cause', () => {
    const outage = new GraphUnavailableError('Graph kept failing', { retries: 12, elapsed_ms: 1 });

    const wrapped = transient_download_error_for(outage, 'report.docx (item-1)');

    expect(wrapped).toBeInstanceOf(TransientDownloadError);
    expect(wrapped?.cause).toBe(outage);
    expect(wrapped?.message).toContain('report.docx (item-1)');
    expect(wrapped?.message).toContain('Graph kept failing');
  });

  it('leaves a failure that belongs to the file alone', () => {
    expect(transient_download_error_for(graph_error(404), 'report.docx')).toBeUndefined();
  });
});

describe('spares_failed_item_attempt', () => {
  it('spares an expired URL and a transient download failure', () => {
    expect(spares_failed_item_attempt(new DownloadUrlExpiredError('expired', undefined))).toBe(
      true,
    );
    expect(spares_failed_item_attempt(new TransientDownloadError('down', undefined))).toBe(true);
  });

  it('does not spare an unwrapped failure, which the caller decides on itself', () => {
    expect(spares_failed_item_attempt(graph_error(503))).toBe(false);
    expect(spares_failed_item_attempt(new DownloadSizeChangedError('size', 1, 2))).toBe(false);
  });
});
