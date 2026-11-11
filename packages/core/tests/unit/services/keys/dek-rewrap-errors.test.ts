import { describe, it, expect } from 'vitest';
import { StorageError } from '@wisecom/atlas-types';
import {
  DekWrapperChangedError,
  describe_rewrap_write_failure,
} from '@/services/keys/dek-rewrap.errors';

const KEY = '_meta/dek.enc';
const RETENTION_HINT = /Object Lock retention policy/;

/** Builds an error with the fields the AWS SDK sets on an S3 service exception. */
function s3_error(name: string, status: number, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return Object.assign(err, { $metadata: { httpStatusCode: status } });
}

describe('describe_rewrap_write_failure (issue #658)', () => {
  it('reports a 500 whose message contains 412 as the storage failure it is', () => {
    const err = s3_error('InternalError', 500, 'Backend error after 412 ms; request 412abc');

    const described = describe_rewrap_write_failure(KEY, err);

    expect(described).toBe(err);
    expect(described).not.toBeInstanceOf(DekWrapperChangedError);
  });

  it('reports a 500 whose message mentions access denied without the retention hint', () => {
    const err = s3_error('InternalError', 500, 'access denied by an upstream cache; retry');
    expect(describe_rewrap_write_failure(KEY, err)).toBe(err);
  });

  it.each([
    [
      'the adapter error name',
      s3_error('PreconditionFailedError', 412, 'Conditional write failed'),
    ],
    ['the raw S3 code', s3_error('PreconditionFailed', 412, 'At least one condition failed')],
    ['a 412 status under another name', s3_error('UnknownError', 412, 'UnknownError')],
  ])('maps %s to DekWrapperChangedError', (_label, err) => {
    expect(describe_rewrap_write_failure(KEY, err)).toBeInstanceOf(DekWrapperChangedError);
  });

  it('explains retention for a 403 whose message lacks the words "access denied"', () => {
    const err = s3_error('AllAccessDisabled', 403, 'All access to this object has been disabled');

    const described = describe_rewrap_write_failure(KEY, err);

    expect(described).toBeInstanceOf(StorageError);
    expect(described.message).toMatch(RETENTION_HINT);
    expect(described.cause).toBe(err);
  });

  it('explains retention for the AccessDenied code without a status', () => {
    const err = new Error('Request refused');
    err.name = 'AccessDenied';
    expect(describe_rewrap_write_failure(KEY, err).message).toMatch(RETENTION_HINT);
  });

  it('wraps a non-Error value without classifying its text', () => {
    const described = describe_rewrap_write_failure(KEY, 'HTTP 412 forbidden');
    expect(described).not.toBeInstanceOf(StorageError);
    expect(described.message).toBe('HTTP 412 forbidden');
  });
});
