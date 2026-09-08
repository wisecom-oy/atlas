import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { MAX_SINGLE_COPY_BYTES } from '@/adapters/s3-large-copy';

/**
 * Issue #346: promotion always issued a single `CopyObject`, which AWS refuses for a source over
 * 5 GB. The multipart upload path accepts objects well past that, so a large backup failed at
 * promotion after every byte was already uploaded. MinIO does not enforce the limit, which is why
 * the local suites never saw it, so the branch is decided by the source size rather than by the
 * backend and both take the same one.
 */

const BUCKET = 'test-bucket';
const GIB = 1024 * 1024 * 1024;

function command_names(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map(
    (call) => (call[0] as { constructor: { name: string } }).constructor.name,
  );
}

function inputs_of(send: ReturnType<typeof vi.fn>, name: string): Record<string, unknown>[] {
  return send.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((cmd) => cmd.constructor.name === name)
    .map((cmd) => cmd.input);
}

describe('server-side promotion either side of the single-copy limit (issue #346)', () => {
  let send: ReturnType<typeof vi.fn>;
  let storage: S3ObjectStorage;

  beforeEach(() => {
    send = vi.fn();
    storage = new S3ObjectStorage({ send } as never, BUCKET, new BucketCache());
  });

  /** Answers HeadObject with a size, and every other command with a plausible success. */
  function answer(bytes: number): (command: { constructor: { name: string } }) => Promise<unknown> {
    let part = 0;
    return async (command) => {
      switch (command.constructor.name) {
        case 'HeadObjectCommand':
          return { ContentLength: bytes };
        case 'CreateMultipartUploadCommand':
          return { UploadId: 'upload-1' };
        case 'UploadPartCopyCommand':
          return { CopyPartResult: { ETag: `"etag-${++part}"` } };
        // A retention policy is validated against the bucket before any copy is attempted.
        case 'GetBucketVersioningCommand':
          return { Status: 'Enabled' };
        case 'GetObjectLockConfigurationCommand':
          return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } };
        default:
          return {};
      }
    };
  }

  function given_source_size(bytes: number): void {
    send.mockImplementation(answer(bytes));
  }

  it('uses a single CopyObject exactly at the limit', async () => {
    given_source_size(MAX_SINGLE_COPY_BYTES);

    await storage.copy('staging/big', 'data/big');

    expect(command_names(send)).toEqual(['HeadObjectCommand', 'CopyObjectCommand']);
    expect(inputs_of(send, 'CopyObjectCommand')[0]).toMatchObject({
      Bucket: BUCKET,
      Key: 'data/big',
      CopySource: `${BUCKET}/staging/big`,
    });
  });

  it('switches to ranged UploadPartCopy one byte past the limit', async () => {
    given_source_size(MAX_SINGLE_COPY_BYTES + 1);

    await storage.copy('staging/big', 'data/big');

    expect(command_names(send)).not.toContain('CopyObjectCommand');
    // Six 1 GiB parts for 5 GiB + 1 byte: five full ranges and a one byte tail.
    const parts = inputs_of(send, 'UploadPartCopyCommand');
    expect(parts).toHaveLength(6);
    expect(parts[0]?.['CopySourceRange']).toBe(`bytes=0-${GIB - 1}`);
    expect(parts[5]?.['CopySourceRange']).toBe(
      `bytes=${MAX_SINGLE_COPY_BYTES}-${MAX_SINGLE_COPY_BYTES}`,
    );
    expect(command_names(send).at(-1)).toBe('CompleteMultipartUploadCommand');
  });

  it('carries metadata and Object Lock onto the ranged copy, as the single copy does', async () => {
    given_source_size(6 * GIB);

    await storage.copy(
      'staging/big',
      'data/big',
      { custom: 'meta' },
      { mode: 'COMPLIANCE', retain_until: '2030-01-01T00:00:00.000Z' },
    );

    // Declared on CreateMultipartUpload, which is where they take effect for a multipart target.
    expect(inputs_of(send, 'CreateMultipartUploadCommand')[0]).toMatchObject({
      Metadata: { custom: 'meta' },
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  it('aborts the multipart upload when a part copy fails, then rethrows', async () => {
    const respond = answer(6 * GIB);
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UploadPartCopyCommand') throw new Error('copy refused');
      return respond(command);
    });

    await expect(storage.copy('staging/big', 'data/big')).rejects.toThrow('copy refused');

    expect(command_names(send)).toContain('AbortMultipartUploadCommand');
    expect(command_names(send)).not.toContain('CompleteMultipartUploadCommand');
  });

  it('fails rather than completing when a part copy returns no ETag', async () => {
    const respond = answer(6 * GIB);
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UploadPartCopyCommand') return {};
      return respond(command);
    });

    await expect(storage.copy('staging/big', 'data/big')).rejects.toThrow(/no ETag/);

    expect(command_names(send)).not.toContain('CompleteMultipartUploadCommand');
  });
});
