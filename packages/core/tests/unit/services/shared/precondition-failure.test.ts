import { describe, it, expect } from 'vitest';
import { is_precondition_failure } from '@/services/shared/precondition-failure';

function named(name: string, message = 'x'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('is_precondition_failure', () => {
  it.each([
    ['the S3 adapter error', named('PreconditionFailedError')],
    ['the raw S3 code', named('PreconditionFailed')],
    ['a message naming the status', new Error('412 Precondition Failed')],
    ['a non-Error value naming the status', 'HTTP 412'],
  ])('matches %s', (_label, err) => {
    expect(is_precondition_failure(err)).toBe(true);
  });

  it.each([
    ['an access denial', named('AccessDenied', 'Access Denied')],
    ['a missing key', named('NoSuchKey', 'The specified key does not exist')],
    ['undefined', undefined],
  ])('does not match %s', (_label, err) => {
    expect(is_precondition_failure(err)).toBe(false);
  });
});
