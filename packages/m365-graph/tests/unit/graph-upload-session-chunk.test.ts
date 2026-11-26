/**
 * Issues #878, #891 and #892. The final chunk of an upload session is the request that creates the
 * file or attachment, so it is sent again only after a throttle response, and a final chunk that
 * ended ambiguously is reported as an unknown outcome instead of a refused upload.
 */
import { describe, expect, it } from 'vitest';
import { ThrottledError } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  UploadChunkTransportError,
  is_upload_chunk_retry_safe,
  leaves_commit_unknown,
  upload_chunk_timeout_ms,
} from '@/graph-upload-session-chunk';

const MIB = 1024 * 1024;

/** A Graph error carrying a `Retry-After`, the form a throttling `503` takes. */
function with_retry_after(err: Error, seconds: string): Error {
  return Object.assign(err, { headers: { 'retry-after': seconds } });
}

/** A `fetch failed` whose cause is a reset socket, as undici reports it. */
function reset(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

const TIMEOUT = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });

describe('upload_chunk_timeout_ms', () => {
  it('gives an attachment chunk 60 s and a 10 MiB drive chunk about 82 s', () => {
    expect(upload_chunk_timeout_ms(13 * 320 * 1024)).toBe(60_000);
    expect(upload_chunk_timeout_ms(10 * MIB)).toBe(81_920);
  });
});

describe('is_upload_chunk_retry_safe', () => {
  it.each([
    ['a 500', graph_error(500, 'InternalServerError')],
    ['a 504', graph_error(504, 'GatewayTimeout')],
    ['a 408', graph_error(408, 'RequestTimeout')],
    ['a 429', graph_error(429, 'TooManyRequests')],
    ['a reset', reset()],
    ['a timeout', TIMEOUT],
    ['a transport failure', new UploadChunkTransportError('no answer within 60 s')],
  ])('repeats an intermediate chunk after %s', (_label, err) => {
    expect(is_upload_chunk_retry_safe(err, 'intermediate')).toBe(true);
  });

  it.each([
    ['a 400', graph_error(400, 'BadRequest')],
    ['a 404', graph_error(404, 'itemNotFound')],
    ['a 416', graph_error(416, 'invalidRange')],
  ])('does not repeat an intermediate chunk after %s', (_label, err) => {
    expect(is_upload_chunk_retry_safe(err, 'intermediate')).toBe(false);
  });

  it.each([
    ['a 429', graph_error(429, 'TooManyRequests')],
    ['a 503 with Retry-After', with_retry_after(graph_error(503, 'ServiceUnavailable'), '5')],
  ])('repeats the committing chunk after %s', (_label, err) => {
    expect(is_upload_chunk_retry_safe(err, 'commit')).toBe(true);
  });

  it.each([
    ['a 500', graph_error(500, 'InternalServerError')],
    ['a 502', graph_error(502, 'BadGateway')],
    ['a 504', graph_error(504, 'GatewayTimeout')],
    ['a 503 without Retry-After', graph_error(503, 'ServiceUnavailable')],
    ['a reset', reset()],
    ['a timeout', TIMEOUT],
  ])('does not repeat the committing chunk after %s', (_label, err) => {
    expect(is_upload_chunk_retry_safe(err, 'commit')).toBe(false);
  });
});

describe('leaves_commit_unknown', () => {
  it.each([
    ['a 500', graph_error(500, 'InternalServerError')],
    ['a 502', graph_error(502, 'BadGateway')],
    ['a 504', graph_error(504, 'GatewayTimeout')],
    ['a 503 without Retry-After', graph_error(503, 'ServiceUnavailable')],
    ['a reset', reset()],
    ['a timeout', TIMEOUT],
    ['a deadline', new UploadChunkTransportError('no answer within 60 s')],
  ])('is unknown after %s on the first send', (_label, err) => {
    expect(leaves_commit_unknown(err, 1)).toBe(true);
  });

  it('is a refusal after a 4xx on the first send', () => {
    expect(leaves_commit_unknown(graph_error(400, 'BadRequest'), 1)).toBe(false);
    expect(leaves_commit_unknown(graph_error(416, 'invalidRange'), 1)).toBe(false);
  });

  it('is unknown after a 416 on a re-send, since an earlier send may have landed', () => {
    expect(leaves_commit_unknown(graph_error(416, 'invalidRange'), 2)).toBe(true);
  });

  it('is a refusal after a throttle, however often the chunk was sent', () => {
    expect(leaves_commit_unknown(graph_error(429, 'TooManyRequests'), 3)).toBe(false);
    expect(leaves_commit_unknown(new ThrottledError('kept throttling'), 13)).toBe(false);
  });
});
