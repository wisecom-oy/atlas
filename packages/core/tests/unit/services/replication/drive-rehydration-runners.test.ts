import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_REPLICATION,
  SHAREPOINT_REPLICATION,
  drive_manifest_key,
  type DriveReplicationDescriptor,
} from '@/services/replication/drive-replication-descriptor';
import {
  rehydrate_manifests,
  type RehydrationPlan,
} from '@/services/replication/rehydration-manifests-runner';
import {
  replicate_drive_snapshot_objects,
  type DriveReplicationTally,
} from '@/services/replication/drive-snapshot-replicator';

/**
 * Issue #191. These two runners are the same code apart from the scope field, yet the OneDrive one
 * sat at 91% coverage and the SharePoint one at 4%, because the suite that exercises the OneDrive
 * path mocks `rehydrate_manifests` outright. Driving both through one table is the point: an
 * asymmetry between them now fails a test.
 */

function make_ctx(existing: string[]): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: { exists: async (key: string) => existing.includes(key) },
  } as unknown as TenantContext;
}

const tally = {
  objects_copied: 2,
  objects_skipped: 1,
  objects_failed: 0,
  bytes_copied: 20,
  errors: [] as string[],
  source_manifest_checksum: 'a',
  replicated_manifest_checksum: 'a',
};

vi.mock('@/services/replication/drive-snapshot-replicator', () => ({
  replicate_drive_snapshot_objects: vi.fn(async () => tally),
}));
const mocked_replicator = vi.mocked(replicate_drive_snapshot_objects);
type Workload = {
  readonly name: string;
  readonly descriptor:
    | DriveReplicationDescriptor<OneDriveSnapshotManifest>
    | DriveReplicationDescriptor<SharePointSnapshotManifest>;
  readonly manifest: (snapshot_id: string) => OneDriveSnapshotManifest | SharePointSnapshotManifest;
};

const workloads: Workload[] = [
  {
    name: 'onedrive',
    descriptor: ONEDRIVE_REPLICATION,
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, owner_id: 'owner-1' }) as OneDriveSnapshotManifest,
  },
  {
    name: 'sharepoint',
    descriptor: SHAREPOINT_REPLICATION,
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, site_id: 'site-1' }) as SharePointSnapshotManifest,
  },
];

describe.each(workloads)('rehydrate_$name_manifests', (w) => {
  const source = { target_id: 'replica' } as never;

  beforeEach(() => {
    mocked_replicator.mockClear();
  });

  function make_plan(): RehydrationPlan<OneDriveSnapshotManifest | SharePointSnapshotManifest> {
    return {
      manifest_key: (manifest) => drive_manifest_key(w.descriptor as never, manifest as never),
      replicate: (source_ctx, primary_ctx, manifest) =>
        mocked_replicator(
          source_ctx,
          primary_ctx,
          manifest as never,
          drive_manifest_key(w.descriptor as never, manifest as never),
        ),
    };
  }

  it('validates the DEK pair before reading any object', async () => {
    const order: string[] = [];
    const validate_dek = vi.fn(async () => {
      order.push('validate');
    });
    mocked_replicator.mockImplementation(async () => {
      order.push('replicate');
      return tally as never;
    });

    await rehydrate_manifests(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never],
      source,
      'tenant-1',
      validate_dek,
      'passphrase',
      make_plan(),
    );

    expect(order).toEqual(['validate', 'replicate']);
  });

  it('skips a manifest already present on the primary without copying it', async () => {
    mocked_replicator.mockImplementation(async () => tally as never);

    const key = drive_manifest_key(w.descriptor as never, w.manifest('snap-1') as never);
    const result = await rehydrate_manifests(
      make_ctx([]),
      make_ctx([key]),
      [w.manifest('snap-1') as never],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
      make_plan(),
    );

    expect(mocked_replicator).not.toHaveBeenCalled();
    expect(result.objects_skipped).toBe(1);
    expect(result.objects_copied).toBe(0);
  });

  it('aggregates the tallies across several snapshots', async () => {
    mocked_replicator.mockImplementation(async () => tally as never);

    const result = await rehydrate_manifests(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never, w.manifest('snap-2') as never],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
      make_plan(),
    );

    expect(result.objects_copied).toBe(4);
    expect(result.objects_skipped).toBe(2);
  });

  it('labels a single-snapshot run with its snapshot id', async () => {
    mocked_replicator.mockImplementation(async () => tally as never);

    const result = await rehydrate_manifests(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
      make_plan(),
    );

    expect(result.snapshot_id).toBe('snap-1');
  });

  it('labels a multi-snapshot run with the count it actually copied', async () => {
    mocked_replicator.mockImplementation(async () => tally as never);

    const key = drive_manifest_key(w.descriptor as never, w.manifest('snap-2') as never);
    const result = await rehydrate_manifests(
      make_ctx([]),
      make_ctx([key]),
      [w.manifest('snap-1') as never, w.manifest('snap-2') as never],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
      make_plan(),
    );

    // snap-2 was already there, so one snapshot was copied out of two requested.
    expect(result.snapshot_id).toBe('1-snapshots');
  });

  it('propagates a DEK mismatch instead of rehydrating under the wrong key', async () => {
    const validate_dek = vi.fn(() => {
      throw Object.assign(new Error('DEK mismatch'), { name: 'DekMismatchError' });
    });

    await expect(
      rehydrate_manifests(
        make_ctx([]),
        make_ctx([]),
        [w.manifest('snap-1') as never],
        source,
        'tenant-1',
        validate_dek,
        'passphrase',
        make_plan(),
      ),
    ).rejects.toThrow('DEK mismatch');
  });
});
