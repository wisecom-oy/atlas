/**
 * Issue #725: `onedrive delete -s` and `sharepoint delete -s` removed one manifest and nothing
 * else. The delta cursor kept pointing past the deleted run, so the next backup never captured
 * again what only that snapshot recorded. And deleting an older snapshot dropped the files it
 * recorded from every newer snapshot, because a newer snapshot folds the chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import {
  NotFoundError,
  ObjectLockRetainedError,
  SnapshotNotNewestError,
  UnreadableObjectsError,
  type DeletionResult,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { SharePointDeletionService } from '@/services/deletion/sharepoint-deletion.service';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

interface StoredSnapshot {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

const S1: StoredSnapshot = { snapshot_id: 'snap-1', created_at: new Date('2026-03-01T10:00:00Z') };
const S2: StoredSnapshot = { snapshot_id: 'snap-2', created_at: new Date('2026-03-02T10:00:00Z') };

/** The manifest reads both providers' repositories offer, under one pair of names. */
interface ManifestReads {
  readonly find_by_snapshot: ReturnType<typeof vi.fn>;
  readonly list_owner_manifests: ReturnType<typeof vi.fn>;
}

interface Workload {
  readonly name: string;
  readonly prefix: string;
  readonly owner: string;
  readonly owner_noun: string;
  readonly build: (
    factory: TenantContextFactory,
    reads: ManifestReads,
  ) => (snapshot_id: string) => Promise<DeletionResult>;
}

const WORKLOADS: Workload[] = [
  {
    name: 'OneDrive',
    prefix: 'onedrive',
    owner: '00000000-0000-0000-0000-00000000abcd',
    owner_noun: 'OneDrive',
    build: (factory, reads) => {
      const service = new OneDriveDeletionService(
        factory,
        {
          find_by_snapshot: reads.find_by_snapshot,
          list_snapshots_by_owner: reads.list_owner_manifests,
        } as never,
        stub_owner_leases().leases,
      );
      return (snapshot_id) =>
        service.delete_snapshot('t', '00000000-0000-0000-0000-00000000abcd', snapshot_id);
    },
  },
  {
    name: 'SharePoint',
    prefix: 'sharepoint',
    owner: 'contoso.sharepoint.com,site-guid,web-guid',
    owner_noun: 'site',
    build: (factory, reads) => {
      const service = new SharePointDeletionService(
        factory,
        {
          find_by_snapshot: reads.find_by_snapshot,
          list_snapshots_by_site: reads.list_owner_manifests,
        } as never,
        stub_owner_leases().leases,
      );
      return (snapshot_id) =>
        service.delete_snapshot('t', 'contoso.sharepoint.com,site-guid,web-guid', snapshot_id);
    },
  },
];

/** A bucket of keys whose listing and deletes behave like an unversioned S3 backend. */
function make_bucket(initial: string[]) {
  const keys = new Set(initial);
  const storage = {
    list: vi.fn(async (prefix: string) => [...keys].filter((k) => k.startsWith(prefix)).sort()),
    list_versions: vi.fn(async () => []),
    delete: vi.fn(async (key: string) => void keys.delete(key)),
    delete_version: vi.fn(),
  };
  const destroy = vi.fn();
  const ctx = { tenant_id: 't', storage, destroy } as unknown as TenantContext;
  return { keys, storage, ctx, destroy };
}

describe.each(WORKLOADS)('$name delete -s and the delta cursor', (workload) => {
  const { prefix, owner } = workload;
  const manifest_key = (snapshot_id: string) => `${prefix}/manifests/${owner}/${snapshot_id}.json`;
  const cursor_key = `${prefix}/_meta/${owner}/delta.json`;
  const index_key = (snapshot_id: string) => `${prefix}/index/${owner}/runs/${snapshot_id}.json`;

  let bucket: ReturnType<typeof make_bucket>;
  let reads: ManifestReads;
  let delete_snapshot: (snapshot_id: string) => Promise<DeletionResult>;

  beforeEach(() => {
    bucket = make_bucket([
      manifest_key('snap-1'),
      manifest_key('snap-2'),
      index_key('snap-1'),
      index_key('snap-2'),
      cursor_key,
      `${prefix}/_meta/someone-else/delta.json`,
      `${prefix}/data/${owner}/aaa`,
    ]);
    reads = {
      find_by_snapshot: vi.fn(async (_ctx, _owner: string, id: string) =>
        [S1, S2].find((m) => m.snapshot_id === id),
      ),
      list_owner_manifests: vi.fn(async () => [S2, S1]),
    };
    const factory = {
      create: vi.fn(),
      create_readonly: vi.fn(async () => bucket.ctx),
      create_storage_only: vi.fn(),
    } as unknown as TenantContextFactory;
    delete_snapshot = workload.build(factory, reads);
  });

  it('removes the newest snapshot and the cursor that points past it', async () => {
    const result = await delete_snapshot('snap-2');

    expect(bucket.keys.has(manifest_key('snap-2'))).toBe(false);
    expect(bucket.keys.has(cursor_key)).toBe(false);
    expect(result.deleted_manifests).toBe(1);
    expect(bucket.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the older snapshot, the content, other cursors and the version index of the run', async () => {
    await delete_snapshot('snap-2');

    // The index holds the historical versions that run captured. A later full run does not fetch
    // them again for a file whose content is already stored, so deleting it would lose them.
    expect([...bucket.keys].sort()).toEqual(
      [
        manifest_key('snap-1'),
        index_key('snap-1'),
        index_key('snap-2'),
        `${prefix}/_meta/someone-else/delta.json`,
        `${prefix}/data/${owner}/aaa`,
      ].sort(),
    );
  });

  it('reads the manifests of the normalized owner only', async () => {
    await delete_snapshot('snap-2');

    expect(reads.find_by_snapshot).toHaveBeenCalledWith(bucket.ctx, owner, 'snap-2');
    expect(reads.list_owner_manifests).toHaveBeenCalledWith(bucket.ctx, owner);
  });

  it('refuses an older snapshot with the typed error and deletes nothing', async () => {
    const before = [...bucket.keys];

    const refused = delete_snapshot('snap-1');

    await expect(refused).rejects.toBeInstanceOf(SnapshotNotNewestError);
    await expect(refused).rejects.toMatchObject({
      code: 'ATLAS_SNAPSHOT_NOT_NEWEST',
      snapshot_id: 'snap-1',
      newer_snapshot_ids: ['snap-2'],
    });
    await expect(refused).rejects.toThrow(
      `of this ${workload.owner_noun} include the files it recorded`,
    );
    expect([...bucket.keys]).toEqual(before);
    expect(bucket.destroy).toHaveBeenCalled();
  });

  it('treats a snapshot written at the same instant as newer', async () => {
    const twin = { snapshot_id: 'snap-2b', created_at: S2.created_at };
    reads.list_owner_manifests.mockResolvedValue([S1, S2, twin]);

    await expect(delete_snapshot('snap-2')).rejects.toBeInstanceOf(SnapshotNotNewestError);
  });

  it('refuses while a manifest of the owner is unreadable and names it', async () => {
    const damaged = manifest_key('snap-x');
    reads.list_owner_manifests.mockRejectedValue(
      new UnreadableObjectsError('Some manifests are unreadable', [damaged]),
    );
    const before = [...bucket.keys];

    const refused = delete_snapshot('snap-2');

    await expect(refused).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(refused).rejects.toMatchObject({ unreadable_keys: [damaged] });
    await expect(refused).rejects.toThrow(/quarantined/);
    expect([...bucket.keys]).toEqual(before);
  });

  it('raises NotFoundError for an unknown snapshot and leaves the cursor', async () => {
    await expect(delete_snapshot('snap-missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(delete_snapshot('snap-missing')).rejects.toThrow(
      `No ${workload.name} manifest found for snapshot snap-missing`,
    );

    expect(bucket.keys.has(cursor_key)).toBe(true);
  });

  it('keeps the cursor of a manifest Object Lock retains, which is still the newest', async () => {
    bucket.storage.delete.mockImplementation(async (key: string) => {
      if (key === manifest_key('snap-2')) throw new ObjectLockRetainedError(key);
      bucket.keys.delete(key);
    });

    const result = await delete_snapshot('snap-2');

    expect(result.retained_manifests).toBe(1);
    expect(bucket.keys.has(cursor_key)).toBe(true);
  });
});
