import { S3ServiceException } from '@aws-sdk/client-s3';
import { describe, it, expect } from 'vitest';
import { is_backend_mode_rejection, names_object_lock } from '@/adapters/s3-error-classifier';

function s3_error(name: string, message: string): S3ServiceException {
  const err = new S3ServiceException({ name, $fault: 'client', $metadata: {} });
  err.message = message;
  return err;
}

describe('s3-error-classifier', () => {
  describe('is_backend_mode_rejection (issue #640)', () => {
    it('does not treat a generic InvalidArgument as a mode rejection', () => {
      const err = s3_error('InvalidArgument', 'Request parameters are not acceptable');
      expect(is_backend_mode_rejection(err, 'GOVERNANCE')).toBe(false);
    });

    it('does not treat a generic InvalidRequest as a mode rejection', () => {
      const err = s3_error('InvalidRequest', 'bad request');
      expect(is_backend_mode_rejection(err, 'COMPLIANCE')).toBe(false);
    });

    it('treats a rejection that names Object Lock as a mode rejection', () => {
      const err = s3_error('InvalidArgument', 'Object Lock mode is not supported');
      expect(is_backend_mode_rejection(err, 'COMPLIANCE')).toBe(true);
    });

    it('returns false without a mode', () => {
      const err = s3_error('InvalidArgument', 'Object Lock mode is not supported');
      expect(is_backend_mode_rejection(err)).toBe(false);
    });

    it('returns false for errors that are not S3 service exceptions', () => {
      const err = Object.assign(new Error('Object Lock mode is not supported'), {
        name: 'InvalidArgument',
      });
      expect(is_backend_mode_rejection(err, 'GOVERNANCE')).toBe(false);
    });
  });

  describe('names_object_lock', () => {
    it('matches the spaced and unspaced Object Lock wording', () => {
      expect(names_object_lock(s3_error('X', 'Object Lock refused'))).toBe(true);
      expect(names_object_lock(s3_error('ObjectLockConfigurationNotFoundError', ''))).toBe(true);
    });

    it('rejects errors without Object Lock wording', () => {
      expect(names_object_lock(s3_error('InvalidArgument', 'bad request'))).toBe(false);
      expect(names_object_lock('Object Lock')).toBe(false);
    });
  });
});
