import { describe, expect, it, vi } from 'vitest';
import { S3MultipartUploadHandle } from '@/adapters/s3-multipart-upload-handle';

const PARTS = [
  { ETag: '"etag-2"', PartNumber: 2 },
  { ETag: '"etag-1"', PartNumber: 1 },
];

function handle_answering(response: Record<string, unknown>): {
  handle: S3MultipartUploadHandle;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => response);
  const handle = new S3MultipartUploadHandle({ send } as never, 'test-bucket', 'key-1', 'upload-1');
  return { handle, send };
}

describe('completing a multipart upload', () => {
  it('reports the version a versioned bucket created (issue #795)', async () => {
    const { handle } = handle_answering({ VersionId: 'v-1' });

    await expect(handle.complete(PARTS)).resolves.toEqual({ version_id: 'v-1' });
  });

  it('reports no version when the bucket keeps none', async () => {
    const { handle } = handle_answering({});

    await expect(handle.complete(PARTS)).resolves.toEqual({});
  });

  it('assembles the parts in ascending order', async () => {
    const { handle, send } = handle_answering({});

    await handle.complete(PARTS);

    const input = (send.mock.calls[0]?.[0] as { input: { MultipartUpload: { Parts: unknown[] } } })
      .input;
    expect(input.MultipartUpload.Parts).toEqual([PARTS[1], PARTS[0]]);
  });
});
