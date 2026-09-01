import { describe, expect, it } from 'vitest';
import type {
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_REPLICATION,
  SHAREPOINT_REPLICATION,
  type DriveReplicationDescriptor,
} from '@/services/replication/drive-replication-descriptor';
import {
  collect_drive_ancillary_keys,
  diff_drive_manifests,
} from '@/services/replication/drive-replication-result';

/**
 * Issue #191: both drive helper files sat at 10% branch coverage, so the "cursor exists" and
 * "target prefix is empty" branches were never taken by a test. Both are the difference between
 * replicating a complete snapshot and replicating one that cannot be resumed.
 */
function make_ctx(keys: string[], existing: string[] = []): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      list: async (prefix: string) => keys.filter((k) => k.startsWith(prefix)),
      exists: async (key: string) => existing.includes(key),
    },
  } as unknown as TenantContext;
}

type Workload = {
  readonly name: string;
  readonly owner_id: string;
  readonly descriptor:
    | DriveReplicationDescriptor<OneDriveSnapshotManifest>
    | DriveReplicationDescriptor<SharePointSnapshotManifest>;
  readonly cursor_key: string;
  readonly manifest_prefix: string;
  readonly manifest: (snapshot_id: string) => OneDriveSnapshotManifest | SharePointSnapshotManifest;
};

const workloads: Workload[] = [
  {
    name: 'onedrive',
    owner_id: 'owner-1',
    descriptor: ONEDRIVE_REPLICATION,
    cursor_key: 'onedrive/_meta/owner-1/delta.json',
    manifest_prefix: 'onedrive/manifests',
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, owner_id: 'owner-1' }) as OneDriveSnapshotManifest,
  },
  {
    name: 'sharepoint',
    owner_id: 'site-1',
    descriptor: SHAREPOINT_REPLICATION,
    cursor_key: 'sharepoint/_meta/site-1/delta.json',
    manifest_prefix: 'sharepoint/manifests',
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, site_id: 'site-1' }) as SharePointSnapshotManifest,
  },
];

describe.each(workloads)('$name ancillary keys', (w) => {
  it('includes every version index object under the scope root', async () => {
    // The prefix is the scope root, not `files/`: since #161 version rows live under `runs/`.
    const ctx = make_ctx([
      `${w.descriptor.index_prefix}/${w.owner_id}/runs/r1.json`,
      `${w.descriptor.index_prefix}/${w.owner_id}/files/legacy.json`,
      `${w.descriptor.index_prefix}/other-scope/runs/r9.json`,
    ]);

    const keys = await collect_drive_ancillary_keys(w.descriptor as never, ctx, w.owner_id);

    expect(keys).toEqual([
      `${w.descriptor.index_prefix}/${w.owner_id}/runs/r1.json`,
      `${w.descriptor.index_prefix}/${w.owner_id}/files/legacy.json`,
    ]);
  });

  it('appends the delta cursor when it exists', async () => {
    const ctx = make_ctx(
      [`${w.descriptor.index_prefix}/${w.owner_id}/runs/r1.json`],
      [w.cursor_key],
    );

    const keys = await collect_drive_ancillary_keys(w.descriptor as never, ctx, w.owner_id);

    expect(keys.at(-1)).toBe(w.cursor_key);
  });

  it('omits the delta cursor when it does not exist', async () => {
    // A cursor key that is listed but absent would fail the copy and block the manifest, so the
    // existence check is what keeps a first replication from failing.
    const ctx = make_ctx([`${w.descriptor.index_prefix}/${w.owner_id}/runs/r1.json`]);

    const keys = await collect_drive_ancillary_keys(w.descriptor as never, ctx, w.owner_id);

    expect(keys).not.toContain(w.cursor_key);
  });

  it('returns nothing when the scope has no index objects and no cursor', async () => {
    expect(
      await collect_drive_ancillary_keys(w.descriptor as never, make_ctx([]), w.owner_id),
    ).toEqual([]);
  });
});

describe.each(workloads)('$name manifest diff', (w) => {
  it('returns only the snapshots absent from the target', async () => {
    const ctx = make_ctx([`${w.manifest_prefix}/${w.owner_id}/snap-1.json`]);
    const source = [w.manifest('snap-1'), w.manifest('snap-2')];

    const missing = await diff_drive_manifests(
      w.descriptor as never,
      source as never,
      ctx,
      w.owner_id,
    );

    expect(missing).toEqual([w.manifest('snap-2')]);
  });

  it('returns every snapshot when the target prefix is empty', async () => {
    const source = [w.manifest('snap-1'), w.manifest('snap-2')];

    const missing = await diff_drive_manifests(
      w.descriptor as never,
      source as never,
      make_ctx([]),
      w.owner_id,
    );

    expect(missing).toHaveLength(2);
  });

  it('returns nothing when the target already holds them all', async () => {
    const ctx = make_ctx([
      `${w.manifest_prefix}/${w.owner_id}/snap-1.json`,
      `${w.manifest_prefix}/${w.owner_id}/snap-2.json`,
    ]);

    expect(
      await diff_drive_manifests(
        w.descriptor as never,
        [w.manifest('snap-1'), w.manifest('snap-2')] as never,
        ctx,
        w.owner_id,
      ),
    ).toEqual([]);
  });

  it('ignores another scope holding the same snapshot id', async () => {
    const ctx = make_ctx([`${w.manifest_prefix}/other-scope/snap-1.json`]);

    const missing = await diff_drive_manifests(
      w.descriptor as never,
      [w.manifest('snap-1')] as never,
      ctx,
      w.owner_id,
    );

    expect(missing).toHaveLength(1);
  });
});
