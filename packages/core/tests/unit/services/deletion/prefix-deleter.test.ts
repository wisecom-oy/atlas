/**
 * The erasure primitive. These tests pin the two properties an erasure report
 * has to get right: nothing recoverable is left behind, and the summary does not
 * claim otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import { delete_scopes, type DeletionStorage } from '@/services/deletion/shared/prefix-deleter';

interface StubOptions {
  versions?: { key: string; version_id: string; is_delete_marker?: boolean }[];
  keys?: string[];
}

function make_storage({ versions = [], keys = [] }: StubOptions = {}): DeletionStorage {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    delete_version: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(keys),
    list_versions: vi.fn().mockResolvedValue(versions),
  };
}

describe('delete_scopes', () => {
  it('deletes every version by id, not the visible key', async () => {
    const storage = make_storage({
      versions: [
        { key: 'data/u/blob', version_id: 'v1' },
        { key: 'data/u/blob', version_id: 'v2' },
      ],
    });

    const result = await delete_scopes(storage, ['data/u/']);

    // A plain delete here would leave both versions retrievable.
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.delete_version).toHaveBeenCalledWith('data/u/blob', 'v1');
    expect(storage.delete_version).toHaveBeenCalledWith('data/u/blob', 'v2');
    expect(result.deleted_objects).toBe(2);
  });

  it('sweeps delete markers without counting them as erased data', async () => {
    const storage = make_storage({
      versions: [
        { key: 'data/u/blob', version_id: 'v1' },
        { key: 'data/u/blob', version_id: 'marker', is_delete_marker: true },
      ],
    });

    const result = await delete_scopes(storage, ['data/u/']);

    expect(storage.delete_version).toHaveBeenCalledWith('data/u/blob', 'marker');
    expect(result.deleted_objects).toBe(1);
  });

  it('counts manifests separately at any depth', async () => {
    const storage = make_storage({
      versions: [
        { key: 'manifests/u/snap.json', version_id: 'v1' },
        { key: 'onedrive/manifests/u/snap.json', version_id: 'v1' },
        { key: 'onedrive/data/u/blob', version_id: 'v1' },
      ],
    });

    const result = await delete_scopes(storage, ['']);

    expect(result.deleted_manifests).toBe(2);
    expect(result.deleted_objects).toBe(1);
  });

  it('deletes manifests before the objects they reference', async () => {
    const storage = make_storage({
      versions: [
        // Bucket order puts data first; an interrupted sweep must not leave a
        // manifest pointing at blobs that are already gone.
        { key: 'data/u/blob', version_id: 'v1' },
        { key: 'manifests/u/snap.json', version_id: 'v1' },
      ],
    });

    await delete_scopes(storage, ['']);

    const order = vi.mocked(storage.delete_version).mock.calls.map(([key]) => key);
    expect(order).toEqual(['manifests/u/snap.json', 'data/u/blob']);
  });

  it('reports a delete marker it could not remove', async () => {
    const storage = make_storage({
      versions: [{ key: 'data/u/blob', version_id: 'marker', is_delete_marker: true }],
    });
    vi.mocked(storage.delete_version).mockRejectedValue(new Error('AccessDenied: Access Denied'));

    const result = await delete_scopes(storage, ['data/u/']);

    // Uncounted on success, but a marker that outlived the sweep is a survivor:
    // a purge reading this summary as clean would drop the DEK.
    expect(result.failed_objects).toBe(1);
  });

  it('falls back to visible keys when the backend lists no versions', async () => {
    const storage = make_storage({ keys: ['data/u/blob'] });

    const result = await delete_scopes(storage, ['data/u/']);

    expect(storage.delete).toHaveBeenCalledWith('data/u/blob');
    expect(result.deleted_objects).toBe(1);
  });

  it('skips the prefixes the caller holds back', async () => {
    const storage = make_storage({
      versions: [
        { key: 'data/u/blob', version_id: 'v1' },
        { key: '_meta/dek.enc', version_id: 'v1' },
      ],
    });

    const result = await delete_scopes(storage, [''], ['_meta/']);

    expect(storage.delete_version).toHaveBeenCalledTimes(1);
    expect(storage.delete_version).not.toHaveBeenCalledWith('_meta/dek.enc', 'v1');
    expect(result.deleted_objects).toBe(1);
  });

  describe('classifying a refused delete', () => {
    async function delete_failing_with(err: Error) {
      const storage = make_storage({ versions: [{ key: 'data/u/blob', version_id: 'v1' }] });
      vi.mocked(storage.delete_version).mockRejectedValue(err);
      return await delete_scopes(storage, ['data/u/']);
    }

    it('reports a retention refusal as retained', async () => {
      // The storage adapter names the refusal; the wording heuristic that recognises MinIO's
      // WORM message and AWS's object-lock message lives there and is tested there (issue #40).
      const result = await delete_failing_with(new ObjectLockRetainedError('data/u/blob'));

      expect(result.retained_objects).toBe(1);
      expect(result.failed_objects).toBe(0);
    });

    it('reports a bare permission denial as failed, never as retained', async () => {
      // Retention expires and the data goes away on its own; an IAM gap does not.
      // Filing this as "retained" would tell an operator erasure is on track.
      const result = await delete_failing_with(new Error('AccessDenied: Access Denied'));

      expect(result.failed_objects).toBe(1);
      expect(result.retained_objects).toBe(0);
    });

    it('reports an unreachable backend as failed', async () => {
      const result = await delete_failing_with(new Error('ECONNREFUSED 127.0.0.1:9002'));

      expect(result.failed_objects).toBe(1);
      expect(result.retained_objects).toBe(0);
    });
  });
});
