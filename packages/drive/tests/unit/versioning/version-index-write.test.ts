import { describe, expect, it, vi } from 'vitest';
import { RefusedWriteError, StoredObjectConflictError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  read_version_index_object,
  write_run_version_index,
} from '@/versioning/version-index-store';

const KEY = 'onedrive/index/owner-1/runs/od-snap-1000-abc.json';

function payload(indexes: unknown): unknown {
  return { owner_id: 'owner-1', snapshot_id: 'od-snap-1000-abc', indexes };
}

const ROW = { snapshot_id: 'od-snap-1000-abc', backup_at: '2026-01-01T00:00:00.000Z' };

describe('write_run_version_index', () => {
  it('stores a run index its reader accepts, create-only, and reads it back once', async () => {
    const harness = in_memory_tenant_context();
    const put = vi.spyOn(harness.ctx.storage, 'put');
    const get = vi.spyOn(harness.ctx.storage, 'get');

    await write_run_version_index(harness.ctx, {
      key: KEY,
      provider: 'OneDrive',
      payload: payload([{ file_id: 'file-a', owner_id: 'owner-1', versions: [ROW] }]),
    });

    expect(put).toHaveBeenCalledWith(KEY, harness.raw(KEY), undefined, undefined, undefined, true);
    expect(get.mock.calls).toEqual([[KEY]]);
    await expect(read_version_index_object(harness.ctx, KEY)).resolves.toEqual([
      { file_id: 'file-a', owner_id: 'owner-1', versions: [ROW] },
    ]);
  });

  it.each([
    ['a file without its id', [{ owner_id: 'owner-1', versions: [ROW] }]],
    ['a file whose versions are not a list', [{ file_id: 'file-a', versions: 'none' }]],
    ['indexes that are not a list', { file_id: 'file-a' }],
  ])('refuses a run index with %s and writes nothing', async (_label, indexes) => {
    const harness = in_memory_tenant_context();

    const write = write_run_version_index(harness.ctx, {
      key: KEY,
      provider: 'OneDrive',
      payload: payload(indexes),
    });

    await expect(write).rejects.toBeInstanceOf(RefusedWriteError);
    await expect(write).rejects.toThrow(`Refusing to write the OneDrive version index at ${KEY}`);
    expect(harness.keys()).toEqual([]);
  });

  it('never replaces a run index already stored under the snapshot id', async () => {
    const harness = in_memory_tenant_context();
    const first_payload = payload([{ file_id: 'file-a', owner_id: 'owner-1', versions: [ROW] }]);
    await write_run_version_index(harness.ctx, {
      key: KEY,
      provider: 'OneDrive',
      payload: first_payload,
    });
    const first = Buffer.from(harness.raw(KEY)!);

    const colliding = write_run_version_index(harness.ctx, {
      key: KEY,
      provider: 'OneDrive',
      payload: payload([{ file_id: 'file-b', owner_id: 'owner-1', versions: [ROW] }]),
    });

    await expect(colliding).rejects.toBeInstanceOf(StoredObjectConflictError);
    expect(harness.raw(KEY)!.equals(first)).toBe(true);
  });
});
