import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { rehydrate_od_manifests } from '@/services/replication/rehydration-od-manifests-runner';
import { rehydrate_sp_manifests } from '@/services/replication/rehydration-sp-manifests-runner';
import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { replicate_sharepoint_snapshot } from '@/services/replication/sharepoint-snapshot-replicator';

/**
 * Issue #191. These two runners are the same code apart from the scope field, yet the OneDrive one
 * sat at 91% coverage and the SharePoint one at 4%, because the suite that exercises the OneDrive
 * path mocks `rehydrate_sp_manifests` outright. Driving both through one table is the point: an
 * asymmetry between them now fails a test.
 */
const OD_PREFIX = 'onedrive/manifests';
const SP_PREFIX = 'sharepoint/manifests';

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

vi.mock('@/services/replication/onedrive-snapshot-replicator', () => ({
  replicate_onedrive_snapshot: vi.fn(async () => tally),
}));
vi.mock('@/services/replication/sharepoint-snapshot-replicator', () => ({
  replicate_sharepoint_snapshot: vi.fn(async () => tally),
}));
const mocked_od = vi.mocked(replicate_onedrive_snapshot);
const mocked_sp = vi.mocked(replicate_sharepoint_snapshot);

const workloads = [
  {
    name: 'onedrive',
    run: rehydrate_od_manifests,
    replicate: mocked_od,
    key_of: (id: string) => `${OD_PREFIX}/owner-1/${id}.json`,
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, owner_id: 'owner-1' }) as OneDriveSnapshotManifest,
  },
  {
    name: 'sharepoint',
    run: rehydrate_sp_manifests,
    replicate: mocked_sp,
    key_of: (id: string) => `${SP_PREFIX}/site-1/${id}.json`,
    manifest: (snapshot_id: string) =>
      ({ snapshot_id, site_id: 'site-1' }) as SharePointSnapshotManifest,
  },
];

describe.each(workloads)('rehydrate_$name_manifests', (w) => {
  const source = { target_id: 'replica' } as never;
  const run = w.run as (
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    manifests: never[],
    ancillary_keys: string[],
    source: never,
    tenant_id: string,
    validate_dek: unknown,
    passphrase: string,
  ) => Promise<{ snapshot_id: string; objects_copied: number; objects_skipped: number }>;

  beforeEach(() => {
    mocked_od.mockClear();
    mocked_sp.mockClear();
  });

  it('validates the DEK pair before reading any object', async () => {
    const order: string[] = [];
    const validate_dek = vi.fn(async () => {
      order.push('validate');
    });
    w.replicate.mockImplementation(async () => {
      order.push('replicate');
      return tally as never;
    });

    await run(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never],
      [],
      source,
      'tenant-1',
      validate_dek,
      'passphrase',
    );

    expect(order).toEqual(['validate', 'replicate']);
  });

  it('skips a manifest already present on the primary without copying it', async () => {
    w.replicate.mockImplementation(async () => tally as never);

    const result = await run(
      make_ctx([]),
      make_ctx([w.key_of('snap-1')]),
      [w.manifest('snap-1') as never],
      [],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
    );

    expect(w.replicate).not.toHaveBeenCalled();
    expect(result.objects_skipped).toBe(1);
    expect(result.objects_copied).toBe(0);
  });

  it('suppresses the replica marker, since recovered data is not a replica of itself', async () => {
    w.replicate.mockImplementation(async () => tally as never);

    await run(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never],
      ['drive/index/scope/runs/r1.json'],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
    );

    const options = w.replicate.mock.calls[0]?.[4] as {
      skip_marker?: boolean;
      ancillary_keys?: string[];
    };
    expect(options.skip_marker).toBe(true);
    expect(options.ancillary_keys).toEqual(['drive/index/scope/runs/r1.json']);
  });

  it('aggregates the tallies across several snapshots', async () => {
    w.replicate.mockImplementation(async () => tally as never);

    const result = await run(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never, w.manifest('snap-2') as never],
      [],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
    );

    expect(result.objects_copied).toBe(4);
    expect(result.objects_skipped).toBe(2);
  });

  it('labels a single-snapshot run with its snapshot id', async () => {
    w.replicate.mockImplementation(async () => tally as never);

    const result = await run(
      make_ctx([]),
      make_ctx([]),
      [w.manifest('snap-1') as never],
      [],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
    );

    expect(result.snapshot_id).toBe('snap-1');
  });

  it('labels a multi-snapshot run with the count it actually copied', async () => {
    w.replicate.mockImplementation(async () => tally as never);

    const result = await run(
      make_ctx([]),
      make_ctx([w.key_of('snap-2')]),
      [w.manifest('snap-1') as never, w.manifest('snap-2') as never],
      [],
      source,
      'tenant-1',
      vi.fn(async () => undefined),
      'passphrase',
    );

    // snap-2 was already there, so one snapshot was copied out of two requested.
    expect(result.snapshot_id).toBe('1-snapshots');
  });

  it('propagates a DEK mismatch instead of rehydrating under the wrong key', async () => {
    const validate_dek = vi.fn(() => {
      throw Object.assign(new Error('DEK mismatch'), { name: 'DekMismatchError' });
    });

    await expect(
      run(
        make_ctx([]),
        make_ctx([]),
        [w.manifest('snap-1') as never],
        [],
        source,
        'tenant-1',
        validate_dek,
        'passphrase',
      ),
    ).rejects.toThrow('DEK mismatch');
  });
});
