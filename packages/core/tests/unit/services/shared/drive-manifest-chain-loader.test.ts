import { describe, expect, it } from 'vitest';
import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import {
  load_drive_manifest_chain,
  snapshot_epoch_of_key,
  type DriveChainLink,
  type DriveManifestLookup,
} from '@/services/shared/drive-manifest-chain-loader';

/**
 * The drive chain loader moved to core so replication (issue #714) and the drive restore, save and
 * verify paths read a chain the same way. The refusal cases stay covered in the drive package.
 */
const CTX = {} as TenantContext;

function link(epoch: number): DriveChainLink {
  return { snapshot_id: `od-snap-${epoch}-abc`, created_at: new Date(epoch) };
}

function lookup(links: DriveChainLink[]): DriveManifestLookup<DriveChainLink> {
  const key_of = (l: DriveChainLink): string => `onedrive/manifests/owner/${l.snapshot_id}.json`;
  return {
    workload: 'OneDrive',
    find_by_snapshot: async (_ctx, _owner, id) => links.find((l) => l.snapshot_id === id),
    list_snapshot_summaries: async () => ({
      summaries: links.map((l): SnapshotSummary => ({
        snapshot_id: l.snapshot_id,
        created_at: l.created_at,
        manifest_key: key_of(l),
        entry_count: 0,
        total_size_bytes: 0,
      })),
      unreadable_keys: [],
    }),
    read_manifest_at: async (_ctx, key) => links.find((l) => key_of(l) === key),
  };
}

describe('load_drive_manifest_chain', () => {
  it('returns the target and every older manifest, newest first, leaving newer ones out', async () => {
    const all = [link(1000), link(3000), link(2000), link(4000)];

    const chain = await load_drive_manifest_chain(lookup(all), CTX, 'owner', 'od-snap-3000-abc');

    expect(chain.target.snapshot_id).toBe('od-snap-3000-abc');
    expect(chain.manifests.map((m) => m.created_at.getTime())).toEqual([3000, 2000, 1000]);
  });

  it('raises NotFoundError naming the workload when the snapshot is absent', async () => {
    await expect(
      load_drive_manifest_chain(lookup([]), CTX, 'owner', 'od-snap-1-abc'),
    ).rejects.toThrow(NotFoundError);
  });

  it('reads the epoch from both providers snapshot keys', () => {
    expect(snapshot_epoch_of_key('onedrive/manifests/owner/od-snap-1234-abc.json')).toBe(1234);
    expect(snapshot_epoch_of_key('sharepoint/manifests/site/sp-snap-99-abc.json')).toBe(99);
    expect(snapshot_epoch_of_key('onedrive/manifests/owner/whatever.json')).toBeUndefined();
  });
});
