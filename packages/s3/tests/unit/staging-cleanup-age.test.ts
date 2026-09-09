import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';

/**
 * Issue #345: startup cleanup swept an owner's staging prefix with no age filter, so a second
 * backup of the same owner aborted the multipart upload the first one was streaming into and
 * deleted the staging object it was about to copy. Both runs share the prefix; only time
 * distinguishes an abandoned upload from a live one.
 */

const BUCKET = 'test-bucket';
const PREFIX = 'onedrive/staging/owner-1/';
// Everything before the cutoff is abandoned; a run that started after it may still be streaming.
const CUTOFF = new Date('2026-03-15T12:00:00Z');
const ABANDONED = new Date('2026-03-14T09:00:00Z');
const LIVE = new Date('2026-03-15T12:30:00Z');
function inputs_of(send: ReturnType<typeof vi.fn>, name: string): Record<string, unknown>[] {
  return send.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((cmd) => cmd.constructor.name === name)
    .map((cmd) => cmd.input);
}

describe('staging cleanup age filter (issue #345)', () => {
  let send: ReturnType<typeof vi.fn>;
  let storage: S3ObjectStorage;

  beforeEach(() => {
    send = vi.fn();
    storage = new S3ObjectStorage({ send } as never, BUCKET, new BucketCache());
  });

  it('aborts an abandoned upload and leaves a live one from a concurrent run alone', async () => {
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListMultipartUploadsCommand') {
        return {
          Uploads: [
            { Key: `${PREFIX}item-a`, UploadId: 'abandoned', Initiated: ABANDONED },
            { Key: `${PREFIX}item-b`, UploadId: 'live', Initiated: LIVE },
          ],
          IsTruncated: false,
        };
      }
      return {};
    });

    const aborted = await storage.abort_incomplete_uploads(PREFIX, CUTOFF);

    expect(aborted).toBe(1);
    expect(inputs_of(send, 'AbortMultipartUploadCommand').map((input) => input.UploadId)).toEqual([
      'abandoned',
    ]);
  });

  it('leaves an old upload that is still receiving parts', async () => {
    // Nothing caps one item's transfer at the cutoff: a very large file on a throttled link runs
    // for hours, and aborting it is the concurrency failure this is all about (issue #345).
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListMultipartUploadsCommand') {
        return {
          Uploads: [{ Key: `${PREFIX}item-a`, UploadId: 'slow-but-alive', Initiated: ABANDONED }],
          IsTruncated: false,
        };
      }
      if (command.constructor.name === 'ListPartsCommand') {
        return { Parts: [{ PartNumber: 1, LastModified: LIVE }], IsTruncated: false };
      }
      return {};
    });

    expect(await storage.abort_incomplete_uploads(PREFIX, CUTOFF)).toBe(0);
    expect(inputs_of(send, 'AbortMultipartUploadCommand')).toHaveLength(0);
  });

  it('aborts an old upload whose last part is older than the cutoff too', async () => {
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListMultipartUploadsCommand') {
        return {
          Uploads: [{ Key: `${PREFIX}item-a`, UploadId: 'stranded', Initiated: ABANDONED }],
          IsTruncated: false,
        };
      }
      if (command.constructor.name === 'ListPartsCommand') {
        return { Parts: [{ PartNumber: 1, LastModified: ABANDONED }], IsTruncated: false };
      }
      return {};
    });

    expect(await storage.abort_incomplete_uploads(PREFIX, CUTOFF)).toBe(1);
  });
  it('leaves an upload whose start time the backend did not report', async () => {
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListMultipartUploadsCommand') {
        return {
          Uploads: [{ Key: `${PREFIX}item-c`, UploadId: 'unknown-age' }],
          IsTruncated: false,
        };
      }
      return {};
    });

    expect(await storage.abort_incomplete_uploads(PREFIX, CUTOFF)).toBe(0);
    expect(inputs_of(send, 'AbortMultipartUploadCommand')).toHaveLength(0);
  });

  it('lists only staging objects older than the cutoff', async () => {
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return {
          Contents: [
            { Key: `${PREFIX}item-a`, LastModified: ABANDONED },
            { Key: `${PREFIX}item-b`, LastModified: LIVE },
            { Key: `${PREFIX}item-c` },
          ],
        };
      }
      return {};
    });

    expect(await storage.list_stale(PREFIX, CUTOFF)).toEqual([`${PREFIX}item-a`]);
  });
});
