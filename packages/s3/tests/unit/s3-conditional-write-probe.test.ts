import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { probe_conditional_writes } from '@/adapters/s3-conditional-write-probe';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';

function make_storage(second_put: () => Promise<void>, versions: string[] = []): ObjectStorage {
  return {
    put: vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(second_put),
    list_versions: vi.fn(async (key: string) =>
      versions.map((version_id) => ({ key, version_id, is_delete_marker: false })),
    ),
    delete_version: vi.fn(),
    delete: vi.fn(),
  } as unknown as ObjectStorage;
}

describe('probe_conditional_writes', () => {
  it('reports support when the second create-only write is refused', async () => {
    const storage = make_storage(async () => {
      throw new PreconditionFailedError('probe');
    });

    await expect(probe_conditional_writes(storage)).resolves.toBe(true);
    const [first, second] = vi.mocked(storage.put).mock.calls;
    expect(first?.[5]).toBe(true);
    expect(second?.[5]).toBe(true);
    expect(first?.[0]).toMatch(/^_meta\/storage-check\/conditional-write-[0-9a-f]+\.probe$/);
  });

  it('reports no support when the backend lets the second write overwrite', async () => {
    const storage = make_storage(async () => undefined);

    await expect(probe_conditional_writes(storage)).resolves.toBe(false);
  });

  it('removes every version of the probe on a versioned bucket', async () => {
    const storage = make_storage(async () => undefined, ['v1', 'v2']);

    await probe_conditional_writes(storage);

    expect(vi.mocked(storage.delete_version).mock.calls.map((call) => call[1])).toEqual([
      'v1',
      'v2',
    ]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('reports unknown when it cannot write at all', async () => {
    const storage = {
      put: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })),
      list_versions: vi.fn(),
      delete: vi.fn(),
    } as unknown as ObjectStorage;

    await expect(probe_conditional_writes(storage)).resolves.toBeUndefined();
    expect(storage.list_versions).not.toHaveBeenCalled();
  });
});
