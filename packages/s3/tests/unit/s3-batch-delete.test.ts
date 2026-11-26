/**
 * Issue #922: `delete_batch` sends `DeleteObjects`, maps each key's error onto retained or failed,
 * and falls back to one delete per target on a backend that refuses the bulk request.
 */
import { describe, it, expect, vi } from 'vitest';
import { DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { BucketCache } from '@/adapters/bucket-cache';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { s3_error, start_fake_s3 } from './fake-s3-server';

function storage_over(send: ReturnType<typeof vi.fn>): S3ObjectStorage {
  return new S3ObjectStorage({ send } as never, 'test-bucket', new BucketCache());
}

function named(name: string, message = name, status?: number): Error {
  return Object.assign(new Error(message), {
    name,
    ...(status !== undefined ? { $metadata: { httpStatusCode: status } } : {}),
  });
}

/** Answers every `DeleteObjects` with each requested object deleted, and records its input. */
function deleting_everything() {
  return vi.fn(async (command: { input: { Delete?: { Objects?: unknown[] } } }) => ({
    Deleted: command.input.Delete?.Objects ?? [],
  }));
}

const TARGETS = [
  { key: 'data/u/a', version_id: 'v1' },
  { key: 'data/u/b', version_id: 'v2' },
  { key: 'data/u/c' },
];

describe('S3ObjectStorage.delete_batch', () => {
  it('deletes versions with one DeleteObjects request that never bypasses governance', async () => {
    const send = deleting_everything();

    const outcomes = await storage_over(send).delete_batch(TARGETS);

    expect(outcomes).toEqual(['deleted', 'deleted', 'deleted']);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as unknown as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: 'test-bucket',
      Delete: {
        Objects: [
          { Key: 'data/u/a', VersionId: 'v1' },
          { Key: 'data/u/b', VersionId: 'v2' },
          { Key: 'data/u/c' },
        ],
        Quiet: false,
      },
    });
  });

  it('maps a retention refusal to retained and any other key error to failed', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Deleted: [{ Key: 'data/u/a', VersionId: 'v1' }],
      Errors: [
        {
          Key: 'data/u/b',
          VersionId: 'v2',
          Code: 'AccessDenied',
          Message: 'Access Denied because object protected by object lock.',
        },
        { Key: 'data/u/c', Code: 'AccessDenied', Message: 'Access Denied' },
      ],
    });

    const outcomes = await storage_over(send).delete_batch(TARGETS);

    expect(outcomes).toEqual(['deleted', 'retained', 'failed']);
  });

  it('counts a target the response does not mention as failed', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Deleted: [{ Key: 'data/u/a', VersionId: 'v1' }] });

    const outcomes = await storage_over(send).delete_batch(TARGETS);

    // A version deleted under another id is not a confirmation that this one is gone.
    expect(outcomes).toEqual(['deleted', 'failed', 'failed']);
  });

  it('splits more than 1,000 targets across requests', async () => {
    const send = deleting_everything();
    const targets = Array.from({ length: 2_300 }, (_, i) => ({ key: `k${i}`, version_id: 'v' }));

    const outcomes = await storage_over(send).delete_batch(targets);

    expect(outcomes).toHaveLength(2_300);
    expect(outcomes.every((outcome) => outcome === 'deleted')).toBe(true);
    const sizes = send.mock.calls.map(([command]) => (command.input.Delete?.Objects ?? []).length);
    expect(sizes).toEqual([1000, 1000, 300]);
  });

  it('falls back to single deletes for good once the backend refuses DeleteObjects', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DeleteObjectsCommand) throw named('NotImplemented', 'nope', 501);
      const { Key: key } = (command as DeleteObjectCommand).input;
      if (key === 'data/u/b') throw named('InvalidRequest', 'Object is WORM protected');
      return {};
    });
    const storage = storage_over(send);

    const first = await storage.delete_batch(TARGETS);
    const second = await storage.delete_batch([{ key: 'data/u/d', version_id: 'v4' }]);

    expect(first).toEqual(['deleted', 'retained', 'deleted']);
    expect(second).toEqual(['deleted']);
    const bulk = send.mock.calls.filter(([command]) => command instanceof DeleteObjectsCommand);
    expect(bulk).toHaveLength(1);
    const singles = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteObjectCommand)
      .map((command) => (command as DeleteObjectCommand).input);
    expect(singles).toContainEqual({ Bucket: 'test-bucket', Key: 'data/u/a', VersionId: 'v1' });
    expect(singles).toContainEqual({ Bucket: 'test-bucket', Key: 'data/u/c' });
    expect(singles).toHaveLength(4);
  });

  it('propagates a refusal that is not about support, without deleting singly', async () => {
    const send = vi.fn().mockRejectedValue(named('AccessDenied', 'Access Denied', 403));

    await expect(storage_over(send).delete_batch(TARGETS)).rejects.toThrow('Access Denied');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('S3ObjectStorage.delete_batch over HTTP', () => {
  it('sends Content-MD5 and a checksum, and falls back on a real 501', async () => {
    const seen: {
      method: string | undefined;
      md5: string | undefined;
      checksum: boolean;
      query: string | undefined;
    }[] = [];
    const s3 = await start_fake_s3((req) => {
      seen.push({
        method: req.method,
        md5: req.headers['content-md5'] as string | undefined,
        checksum: Object.keys(req.headers).some((h) => h.startsWith('x-amz-checksum-')),
        query: req.url,
      });
      if (req.method === 'POST') return s3_error(501, 'NotImplemented');
      return { status: 204 };
    });
    try {
      const storage = new S3ObjectStorage(s3.client, 'test-bucket', new BucketCache());

      const outcomes = await storage.delete_batch(TARGETS);

      expect(outcomes).toEqual(['deleted', 'deleted', 'deleted']);
      expect(seen[0]).toMatchObject({ method: 'POST', checksum: true });
      expect(seen[0]!.md5).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(seen[0]!.query).toContain('delete');
      // The client retries the 501 as a server error before the adapter sees it.
      const methods = seen.map((request) => request.method);
      const posts = methods.filter((method) => method === 'POST').length;
      expect(methods).toEqual([...Array<string>(posts).fill('POST'), 'DELETE', 'DELETE', 'DELETE']);
    } finally {
      await s3.close();
    }
  });
});
