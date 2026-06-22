import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { reset_bucket_cache } from '@/adapters/s3-bucket-manager';
import {
  ObjectLockUnsupportedError,
  ObjectLockVersioningDisabledError,
} from '@/adapters/object-lock.errors';

function make_mock_s3(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('S3ObjectStorage', () => {
  let mock_s3: ReturnType<typeof make_mock_s3>;
  let storage: S3ObjectStorage;
  const bucket = 'test-bucket';

  beforeEach(() => {
    mock_s3 = make_mock_s3();
    storage = new S3ObjectStorage(mock_s3 as never, bucket);
    reset_bucket_cache();
  });

  describe('put', () => {
    it('sends PutObjectCommand with Content-MD5', async () => {
      const data = Buffer.from('test data');
      mock_s3.send.mockResolvedValueOnce({});

      await storage.put('my-key', data, { custom: 'meta' });

      expect(mock_s3.send).toHaveBeenCalledOnce();
      const cmd = mock_s3.send.mock.calls[0][0];
      expect(cmd.input.Bucket).toBe(bucket);
      expect(cmd.input.Key).toBe('my-key');
      expect(cmd.input.Body).toBe(data);
      expect(cmd.input.ContentMD5).toBeDefined();
      expect(cmd.input.Metadata).toEqual({ custom: 'meta' });
    });

    it('computes correct base64 Content-MD5', async () => {
      const { createHash: create_hash } = await import('node:crypto');
      const data = Buffer.from('hello');
      const expected_md5 = create_hash('md5').update(data).digest('base64');
      mock_s3.send.mockResolvedValueOnce({});

      await storage.put('k', data);

      const cmd = mock_s3.send.mock.calls[0][0];
      expect(cmd.input.ContentMD5).toBe(expected_md5);
    });

    it('applies object lock options for immutable upload', async () => {
      mock_s3.send
        .mockResolvedValueOnce({}) // HeadBucket
        .mockResolvedValueOnce({ Status: 'Enabled' }) // GetBucketVersioning
        .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }) // GetObjectLockConfiguration
        .mockResolvedValueOnce({}); // PutObject

      await storage.put('immutable', Buffer.from('body'), undefined, {
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      });

      const cmd = mock_s3.send.mock.calls.at(-1)?.[0];
      expect(cmd.input.ObjectLockMode).toBe('GOVERNANCE');
      expect(cmd.input.ObjectLockRetainUntilDate).toBeInstanceOf(Date);
    });

    it('fails with versioning-specific error when immutability requested and versioning is disabled', async () => {
      mock_s3.send
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Status: 'Suspended' })
        .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

      await expect(
        storage.put('immutable', Buffer.from('body'), undefined, {
          mode: 'GOVERNANCE',
          retain_until: '2026-04-08T12:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ObjectLockVersioningDisabledError);
    });

    it('fails with object-lock-specific error when object lock is disabled', async () => {
      mock_s3.send
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Status: 'Enabled' })
        .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Disabled' } });

      await expect(
        storage.put('immutable', Buffer.from('body'), undefined, {
          mode: 'GOVERNANCE',
          retain_until: '2026-04-08T12:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ObjectLockUnsupportedError);
    });
  });

  describe('get', () => {
    it('returns buffer from response body', async () => {
      const body_bytes = new Uint8Array([1, 2, 3]);
      mock_s3.send.mockResolvedValueOnce({
        Body: { transformToByteArray: async () => body_bytes },
      });

      const result = await storage.get('key');
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(Buffer.from(body_bytes));
    });

    it('throws on empty body', async () => {
      mock_s3.send.mockResolvedValueOnce({ Body: undefined });
      await expect(storage.get('key')).rejects.toThrow('Empty response body');
    });
  });

  describe('exists', () => {
    it('returns true when HeadObject succeeds', async () => {
      mock_s3.send.mockResolvedValueOnce({});
      expect(await storage.exists('key')).toBe(true);
    });

    it('returns false on NotFound', async () => {
      mock_s3.send.mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotFound' }));
      expect(await storage.exists('key')).toBe(false);
    });

    it('rethrows unexpected errors', async () => {
      mock_s3.send.mockRejectedValueOnce(new Error('network failure'));
      await expect(storage.exists('key')).rejects.toThrow('network failure');
    });
  });

  describe('delete', () => {
    it('sends DeleteObjectCommand', async () => {
      mock_s3.send.mockResolvedValueOnce({});
      await storage.delete('key');

      const cmd = mock_s3.send.mock.calls[0][0];
      expect(cmd.input.Bucket).toBe(bucket);
      expect(cmd.input.Key).toBe('key');
    });
  });

  describe('list', () => {
    it('collects keys from single page', async () => {
      mock_s3.send.mockResolvedValueOnce({
        Contents: [{ Key: 'a' }, { Key: 'b' }],
        NextContinuationToken: undefined,
      });

      const keys = await storage.list('prefix/');
      expect(keys).toEqual(['a', 'b']);
    });

    it('paginates across multiple pages', async () => {
      mock_s3.send
        .mockResolvedValueOnce({
          Contents: [{ Key: 'a' }],
          NextContinuationToken: 'tok',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'b' }],
          NextContinuationToken: undefined,
        });

      const keys = await storage.list('prefix/');
      expect(keys).toEqual(['a', 'b']);
      expect(mock_s3.send).toHaveBeenCalledTimes(2);
    });

    it('returns empty array when no contents', async () => {
      mock_s3.send.mockResolvedValueOnce({ Contents: undefined });
      expect(await storage.list('x')).toEqual([]);
    });
  });

  describe('probe_immutability', () => {
    it('uses cached probe result per bucket', async () => {
      mock_s3.send
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Status: 'Enabled' })
        .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });

      const first = await storage.probe_immutability({ mode: 'GOVERNANCE' });
      const second = await storage.probe_immutability({ mode: 'GOVERNANCE' });

      expect(first.object_lock_enabled).toBe(true);
      expect(second.object_lock_enabled).toBe(true);
      expect(mock_s3.send).toHaveBeenCalledTimes(3);
    });
  });
});
