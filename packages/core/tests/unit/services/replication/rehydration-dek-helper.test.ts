import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensure_source_dek_on_primary,
  DekOverwriteRefusedError,
} from '@/services/replication/rehydration-dek-helper';
import type { ObjectStorage, StorageTarget } from '@wisecom/atlas-types';
import {
  stub_storage_target,
  type StubStorageTarget,
} from '@wisecom/atlas-types/testing/stub-storage-target';

// Regression tests for issue #26: a primary holding only OneDrive/SharePoint
// backups must never be misclassified as empty and have its DEK overwritten.

const DEK_KEY = '_meta/dek.enc';
const SOURCE_DEK = Buffer.from('wrapped-source-dek');
const PRIMARY_DEK = Buffer.from('wrapped-primary-dek');

interface FakeBucket {
  storage: ObjectStorage;
  target: StorageTarget;
  stub: StubStorageTarget;
}

/** Spy-backed storage, so assertions can check which calls the helper made. */
function make_spy_storage(objects: Record<string, Buffer>): ObjectStorage {
  const keys = (): string[] => Object.keys(objects).sort();
  return {
    exists: vi.fn(async (key: string) => key in objects),
    get: vi.fn(async (key: string) => {
      const blob = objects[key];
      if (!blob) throw new Error(`missing ${key}`);
      return blob;
    }),
    put: vi.fn(async (key: string, data: Buffer) => {
      objects[key] = data;
    }),
    list: vi.fn(async (prefix: string, limit?: number) => {
      const matched = keys().filter((k) => k.startsWith(prefix));
      return limit === undefined ? matched : matched.slice(0, limit);
    }),
  } as unknown as ObjectStorage;
}

/** Storage target stub whose bucket holds the given key->blob map. */
function make_target(objects: Record<string, Buffer>): FakeBucket {
  const stub = stub_storage_target({ objects, storage: make_spy_storage(objects) });
  return { storage: stub.storage, target: stub.target, stub };
}

describe('ensure_source_dek_on_primary (issue #26)', () => {
  let source: FakeBucket;

  beforeEach(() => {
    source = make_target({ [DEK_KEY]: SOURCE_DEK, 'manifests/m1.json': Buffer.from('m') });
  });

  it('does nothing when the source has no DEK', async () => {
    const empty_source = make_target({});
    const primary = make_target({ [DEK_KEY]: PRIMARY_DEK });

    await ensure_source_dek_on_primary(primary.target, empty_source.target, 't');

    expect(primary.storage.put).not.toHaveBeenCalled();
  });

  it('copies the source DEK when the primary has none', async () => {
    const primary = make_target({});

    await ensure_source_dek_on_primary(primary.target, source.target, 't');

    expect(primary.storage.put).toHaveBeenCalledWith(DEK_KEY, SOURCE_DEK);
  });

  it('leaves an identical DEK untouched', async () => {
    const primary = make_target({ [DEK_KEY]: Buffer.from(SOURCE_DEK) });

    await ensure_source_dek_on_primary(primary.target, source.target, 't');

    expect(primary.storage.put).not.toHaveBeenCalled();
  });

  it('replaces the DEK when it is the only object in the bucket', async () => {
    const primary = make_target({ [DEK_KEY]: PRIMARY_DEK });

    await ensure_source_dek_on_primary(primary.target, source.target, 't');

    expect(primary.storage.put).toHaveBeenCalledWith(DEK_KEY, SOURCE_DEK);
    expect(primary.storage.list).toHaveBeenCalledWith('', 2);
  });

  it('refuses to overwrite when the primary holds OneDrive-only backups', async () => {
    const primary = make_target({
      [DEK_KEY]: PRIMARY_DEK,
      'onedrive/manifests/owner-1/snap-1.json': Buffer.from('drive manifest'),
    });

    await expect(
      ensure_source_dek_on_primary(primary.target, source.target, 't'),
    ).rejects.toBeInstanceOf(DekOverwriteRefusedError);

    expect(primary.storage.put).not.toHaveBeenCalled();
  });

  it('refuses to overwrite when the primary holds only replication sidecars', async () => {
    const primary = make_target({
      [DEK_KEY]: PRIMARY_DEK,
      '_meta/replication/mbx-1/snap-1/offsite.json': Buffer.from('sidecar'),
    });

    await expect(
      ensure_source_dek_on_primary(primary.target, source.target, 't'),
    ).rejects.toBeInstanceOf(DekOverwriteRefusedError);

    expect(primary.storage.put).not.toHaveBeenCalled();
  });

  /**
   * Issue #200: both contexts were created inline with no `try`, and this
   * function has five exits, so the passphrase buffer behind each
   * EnvelopeKeyService was never zeroed on any of them.
   */
  describe('context lifecycle', () => {
    it('destroys the source context on the early return, when there is no DEK', async () => {
      const empty_source = make_target({});
      const primary = make_target({ [DEK_KEY]: PRIMARY_DEK });

      await ensure_source_dek_on_primary(primary.target, empty_source.target, 't');

      expect(empty_source.stub.destroyed()).toBe(empty_source.stub.created());
      // The primary is never opened on this path, so there is nothing to leak.
      expect(primary.stub.created()).toBe(0);
    });

    it('destroys both contexts when the DEK is copied', async () => {
      const primary = make_target({});

      await ensure_source_dek_on_primary(primary.target, source.target, 't');

      expect(source.stub.destroyed()).toBe(source.stub.created());
      expect(primary.stub.destroyed()).toBe(primary.stub.created());
      expect(primary.stub.created()).toBeGreaterThan(0);
    });

    it('destroys both contexts when an identical DEK short-circuits', async () => {
      const primary = make_target({ [DEK_KEY]: SOURCE_DEK });

      await ensure_source_dek_on_primary(primary.target, source.target, 't');

      expect(source.stub.destroyed()).toBe(source.stub.created());
      expect(primary.stub.destroyed()).toBe(primary.stub.created());
    });

    it('destroys both contexts when the overwrite is refused', async () => {
      const primary = make_target({
        [DEK_KEY]: PRIMARY_DEK,
        'onedrive/manifests/o1.json': Buffer.from('m'),
      });

      await expect(
        ensure_source_dek_on_primary(primary.target, source.target, 't'),
      ).rejects.toBeInstanceOf(DekOverwriteRefusedError);

      expect(source.stub.destroyed()).toBe(source.stub.created());
      expect(primary.stub.destroyed()).toBe(primary.stub.created());
      expect(primary.stub.created()).toBeGreaterThan(0);
    });
  });
});
