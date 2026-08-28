import { describe, expect, it } from 'vitest';
import type {
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  collect_od_ancillary_keys,
  diff_od_manifests,
} from '@/services/replication/onedrive-replication-helpers';
import {
  collect_sp_ancillary_keys,
  diff_sp_manifests,
} from '@/services/replication/sharepoint-replication-helpers';

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

const workloads = [
  {
    name: 'onedrive',
    scope: 'owner-1',
    index_prefix: 'onedrive/index',
    cursor_key: 'onedrive/_meta/owner-1/delta.json',
    manifest_prefix: 'onedrive/manifests',
    collect: collect_od_ancillary_keys,
    diff: diff_od_manifests as (
      source: unknown[],
      ctx: TenantContext,
      scope: string,
    ) => Promise<unknown[]>,
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, owner_id: 'owner-1' }) as OneDriveSnapshotManifest,
  },
  {
    name: 'sharepoint',
    scope: 'site-1',
    index_prefix: 'sharepoint/index',
    cursor_key: 'sharepoint/_meta/site-1/delta.json',
    manifest_prefix: 'sharepoint/manifests',
    collect: collect_sp_ancillary_keys,
    diff: diff_sp_manifests as (
      source: unknown[],
      ctx: TenantContext,
      scope: string,
    ) => Promise<unknown[]>,
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, site_id: 'site-1' }) as SharePointSnapshotManifest,
  },
];

describe.each(workloads)('$name ancillary keys', (w) => {
  it('includes every version index object under the scope root', async () => {
    // The prefix is the scope root, not `files/`: since #161 version rows live under `runs/`.
    const ctx = make_ctx([
      `${w.index_prefix}/${w.scope}/runs/r1.json`,
      `${w.index_prefix}/${w.scope}/files/legacy.json`,
      `${w.index_prefix}/other-scope/runs/r9.json`,
    ]);

    const keys = await w.collect(ctx, w.scope);

    expect(keys).toEqual([
      `${w.index_prefix}/${w.scope}/runs/r1.json`,
      `${w.index_prefix}/${w.scope}/files/legacy.json`,
    ]);
  });

  it('appends the delta cursor when it exists', async () => {
    const ctx = make_ctx([`${w.index_prefix}/${w.scope}/runs/r1.json`], [w.cursor_key]);

    const keys = await w.collect(ctx, w.scope);

    expect(keys.at(-1)).toBe(w.cursor_key);
  });

  it('omits the delta cursor when it does not exist', async () => {
    // A cursor key that is listed but absent would fail the copy and block the manifest, so the
    // existence check is what keeps a first replication from failing.
    const ctx = make_ctx([`${w.index_prefix}/${w.scope}/runs/r1.json`]);

    const keys = await w.collect(ctx, w.scope);

    expect(keys).not.toContain(w.cursor_key);
  });

  it('returns nothing when the scope has no index objects and no cursor', async () => {
    expect(await w.collect(make_ctx([]), w.scope)).toEqual([]);
  });
});

describe.each(workloads)('$name manifest diff', (w) => {
  it('returns only the snapshots absent from the target', async () => {
    const ctx = make_ctx([`${w.manifest_prefix}/${w.scope}/snap-1.json`]);
    const source = [w.manifest('snap-1'), w.manifest('snap-2')];

    const missing = await w.diff(source, ctx, w.scope);

    expect(missing).toEqual([w.manifest('snap-2')]);
  });

  it('returns every snapshot when the target prefix is empty', async () => {
    const source = [w.manifest('snap-1'), w.manifest('snap-2')];

    const missing = await w.diff(source, make_ctx([]), w.scope);

    expect(missing).toHaveLength(2);
  });

  it('returns nothing when the target already holds them all', async () => {
    const ctx = make_ctx([
      `${w.manifest_prefix}/${w.scope}/snap-1.json`,
      `${w.manifest_prefix}/${w.scope}/snap-2.json`,
    ]);

    expect(await w.diff([w.manifest('snap-1'), w.manifest('snap-2')], ctx, w.scope)).toEqual([]);
  });

  it('ignores another scope holding the same snapshot id', async () => {
    const ctx = make_ctx([`${w.manifest_prefix}/other-scope/snap-1.json`]);

    const missing = await w.diff([w.manifest('snap-1')], ctx, w.scope);

    expect(missing).toHaveLength(1);
  });
});
