import { describe, it, expect, vi, type Mock } from 'vitest';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { S3StorageInventory } from '@/adapters/s3-storage-inventory';

type Respond = (command: {
  constructor: { name: string };
  input: Record<string, unknown>;
}) => unknown;

function inventory_with(respond: Respond): { inventory: S3StorageInventory; send: Mock } {
  const send = vi.fn(async (command) => respond(command));
  return { inventory: new S3StorageInventory({ send } as never, 'atlas-bucket'), send };
}

function s3_error(name: string, status: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
    message: name,
  });
}

describe('S3StorageInventory.list_object_page', () => {
  it('maps versions and delete markers with sizes and latest flags', async () => {
    const { inventory } = inventory_with(() => ({
      Versions: [
        { Key: 'data/o/a', Size: 10, IsLatest: true },
        { Key: 'data/o/a', Size: 7, IsLatest: false },
      ],
      DeleteMarkers: [{ Key: 'data/o/b', IsLatest: true }],
      CommonPrefixes: [{ Prefix: 'data/' }],
      IsTruncated: true,
      NextKeyMarker: 'data/o/b',
      NextVersionIdMarker: 'v2',
    }));

    const page = await inventory.list_object_page({ prefix: '', delimiter: '/', mode: 'versions' });

    expect(page).toEqual({
      mode: 'versions',
      objects: [
        { key: 'data/o/a', size: 10, is_latest: true, is_delete_marker: false },
        { key: 'data/o/a', size: 7, is_latest: false, is_delete_marker: false },
        { key: 'data/o/b', size: 0, is_latest: true, is_delete_marker: true },
      ],
      common_prefixes: ['data/'],
      requests: 1,
      next: { key_marker: 'data/o/b', version_id_marker: 'v2' },
    });
  });

  it('falls back to live objects when the first version page is refused', async () => {
    const { inventory, send } = inventory_with((command) => {
      if (command.constructor.name === 'ListObjectVersionsCommand')
        throw s3_error('AccessDenied', 403);
      return { Contents: [{ Key: 'data/o/a', Size: 10 }], IsTruncated: false };
    });

    const page = await inventory.list_object_page({ prefix: 'data/', mode: 'versions' });

    expect(page.mode).toBe('current');
    expect(page.requests).toBe(2);
    expect(page.objects).toEqual([
      { key: 'data/o/a', size: 10, is_latest: true, is_delete_marker: false },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refuses to switch listings mid-prefix, which would count it twice', async () => {
    const { inventory } = inventory_with(() => {
      throw s3_error('AccessDenied', 403);
    });

    await expect(
      inventory.list_object_page({
        prefix: 'data/',
        mode: 'versions',
        cursor: { key_marker: 'k' },
      }),
    ).rejects.toMatchObject({ name: 'AccessDenied' });
  });

  it('propagates failures other than a refusal', async () => {
    const { inventory } = inventory_with(() => {
      throw s3_error('InternalError', 500);
    });

    await expect(
      inventory.list_object_page({ prefix: '', mode: 'versions' }),
    ).rejects.toMatchObject({
      name: 'InternalError',
    });
  });

  it('fails on a truncated page without a marker instead of looping', async () => {
    const { inventory } = inventory_with(() => ({ Contents: [], IsTruncated: true }));

    await expect(inventory.list_object_page({ prefix: '', mode: 'current' })).rejects.toThrow(
      /truncated without a marker/,
    );
  });
});

describe('S3StorageInventory.list_incomplete_upload_page', () => {
  it('sizes each upload across paginated part listings and skips vanished uploads', async () => {
    const { inventory } = inventory_with((command) => {
      const input = command.input;
      if (command.constructor.name === 'ListMultipartUploadsCommand') {
        return {
          Uploads: [
            { Key: 'onedrive/staging/o/a', UploadId: 'u1' },
            { Key: 'onedrive/staging/o/b', UploadId: 'gone' },
          ],
          IsTruncated: false,
        };
      }
      if (input['UploadId'] === 'gone') throw s3_error('NoSuchUpload', 404);
      return input['PartNumberMarker'] === undefined
        ? { Parts: [{ Size: 5 }, { Size: 6 }], IsTruncated: true, NextPartNumberMarker: '2' }
        : { Parts: [{ Size: 1 }], IsTruncated: false };
    });

    const page = await inventory.list_incomplete_upload_page();

    expect(page).toEqual({
      visible: true,
      uploads: [{ key: 'onedrive/staging/o/a', bytes: 12 }],
      requests: 4,
    });
  });

  it('reports a refused upload listing as not visible rather than as no uploads', async () => {
    const { inventory } = inventory_with(() => {
      throw s3_error('AccessDenied', 403);
    });

    await expect(inventory.list_incomplete_upload_page()).resolves.toEqual({
      visible: false,
      uploads: [],
      requests: 1,
    });
  });
});
