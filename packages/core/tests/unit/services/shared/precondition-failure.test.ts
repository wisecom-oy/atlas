import { describe, it, expect } from 'vitest';
import { is_precondition_failure } from '@/services/shared/precondition-failure';

function named(name: string, message = 'x'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function s3_error(name: string, status: number, message: string): Error {
  return Object.assign(named(name, message), { $metadata: { httpStatusCode: status } });
}

describe('is_precondition_failure', () => {
  it.each([
    ['the S3 adapter error', named('PreconditionFailedError')],
    ['the raw S3 code as the name', named('PreconditionFailed')],
    ['the raw S3 code as Code', { Code: 'PreconditionFailed' }],
    ['a 412 status under another name', s3_error('UnknownError', 412, 'Unknown')],
  ])('matches %s', (_label, err) => {
    expect(is_precondition_failure(err)).toBe(true);
  });

  it.each([
    ['an access denial', named('AccessDenied', 'Access Denied')],
    ['a missing key', named('NoSuchKey', 'The specified key does not exist')],
    ['a 500 whose message mentions 412', s3_error('InternalError', 500, 'upstream 412 retry')],
    ['a message naming the precondition', new Error('412 Precondition Failed')],
    ['a non-Error value naming the status', 'HTTP 412'],
    ['undefined', undefined],
  ])('does not match %s', (_label, err) => {
    expect(is_precondition_failure(err)).toBe(false);
  });
});
