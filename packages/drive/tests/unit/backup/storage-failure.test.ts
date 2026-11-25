import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  GraphUnavailableError,
  StorageError,
  StorageUnavailableError,
} from '@wisecom/atlas-types';
import { CdnHttpError } from '@/backup/cdn-chunk-errors';
import { is_storage_failure } from '@/backup/storage-failure';
import { TransientDownloadError } from '@/backup/transient-download-failure';

/** An answer from the S3 endpoint, shaped as the AWS SDK raises it. */
function s3_answer(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

describe('is_storage_failure (issue #917)', () => {
  it.each([
    ['an S3 InternalError', s3_answer('InternalError', 500)],
    ['a 507 from a full MinIO', s3_answer('XMinioStorageFull', 507)],
    ['a QuotaExceeded 403', s3_answer('QuotaExceeded', 403)],
    ['a StorageError', new StorageError('Missing ETag for multipart part 2')],
    ['a StorageUnavailableError', new StorageUnavailableError('no answer', 3)],
    [
      'a ConfigError wrapping an S3 answer',
      new ConfigError('lock mode refused', { cause: s3_answer('InvalidRequest', 400) }),
    ],
  ])('recognises %s', (_label, err) => {
    expect(is_storage_failure(err)).toBe(true);
  });

  it.each([
    ['a Graph 503', Object.assign(new Error('Service Unavailable'), { statusCode: 503 })],
    ['an exhausted Graph retry', new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 })],
    ['a CDN 500', new CdnHttpError('CDN answered 500', 500)],
    ['a socket reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['a transient download', new TransientDownloadError('outage', new Error('reset'))],
    ['a plain error', new Error('size mismatch')],
    ['a string', 'failed'],
    ['null', null],
  ])('does not take %s for a storage failure', (_label, err) => {
    expect(is_storage_failure(err)).toBe(false);
  });

  it('stops on a cyclic cause chain', () => {
    const first = new Error('first') as Error & { cause?: unknown };
    const second = new Error('second', { cause: first });
    first.cause = second;

    expect(is_storage_failure(first)).toBe(false);
  });
});
