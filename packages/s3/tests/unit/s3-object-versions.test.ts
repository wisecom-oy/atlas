import { describe, it, expect, vi } from 'vitest';
import { BucketCache } from '@/adapters/bucket-cache';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';

/**
 * Issue #716: `keys purge-old-wrappers` deletes only versions the listing marks noncurrent, and
 * reads each old version before deleting it.
 */

function storage_over(send: ReturnType<typeof vi.fn>): S3ObjectStorage {
  return new S3ObjectStorage({ send } as never, 'test-bucket', new BucketCache());
}

describe('S3ObjectStorage version access', () => {
  it('reports which version is current, and leaves unstated currency unknown', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Versions: [
        { Key: '_meta/dek.enc', VersionId: 'v2', IsLatest: true },
        { Key: '_meta/dek.enc', VersionId: 'v1', IsLatest: false },
        { Key: '_meta/dek.enc', VersionId: 'v0' },
      ],
      DeleteMarkers: [{ Key: '_meta/dek.enc', VersionId: 'm1', IsLatest: false }],
      IsTruncated: false,
    });

    const versions = await storage_over(send).list_versions('_meta/dek.enc');

    expect(versions).toEqual([
      { key: '_meta/dek.enc', version_id: 'v2', is_delete_marker: false, is_latest: true },
      { key: '_meta/dek.enc', version_id: 'v1', is_delete_marker: false, is_latest: false },
      { key: '_meta/dek.enc', version_id: 'v0', is_delete_marker: false },
      { key: '_meta/dek.enc', version_id: 'm1', is_delete_marker: true, is_latest: false },
    ]);
  });

  it('reads one version by its id', async () => {
    const body = { transformToByteArray: async () => new Uint8Array([1, 2, 3]) };
    const send = vi.fn().mockResolvedValueOnce({ Body: body });

    const data = await storage_over(send).get_version('_meta/dek.enc', 'v1');

    expect(data).toEqual(Buffer.from([1, 2, 3]));
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({ Bucket: 'test-bucket', Key: '_meta/dek.enc', VersionId: 'v1' });
  });

  it('never asks to bypass governance retention when deleting a version', async () => {
    const send = vi.fn().mockResolvedValueOnce({});

    await storage_over(send).delete_version('_meta/dek.enc', 'v1');

    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).not.toHaveProperty('BypassGovernanceRetention');
  });

  it('requests the next version page only when the caller asks for it (issue #922)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Versions: [{ Key: 'data/a', VersionId: 'v1', IsLatest: true }],
        IsTruncated: true,
        NextKeyMarker: 'data/a',
        NextVersionIdMarker: 'v1',
      })
      .mockResolvedValueOnce({
        DeleteMarkers: [{ Key: 'data/b', VersionId: 'm1', IsLatest: true }],
        IsTruncated: false,
      });

    const pages = storage_over(send).list_version_pages('data/')[Symbol.asyncIterator]();
    const first = await pages.next();

    expect(first.value).toEqual([
      { key: 'data/a', version_id: 'v1', is_delete_marker: false, is_latest: true },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const second = await pages.next();
    expect(second.value).toEqual([
      { key: 'data/b', version_id: 'm1', is_delete_marker: true, is_latest: true },
    ]);
    const command = send.mock.calls[1]![0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({ KeyMarker: 'data/a', VersionIdMarker: 'v1' });
    expect((await pages.next()).done).toBe(true);
  });
});
