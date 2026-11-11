import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  load_drive_chain_entries,
  snapshot_epoch_of_key,
  type DriveChainManifest,
  type DriveManifestLookup,
} from '@/shared/manifest-chain';

const CTX = {} as TenantContext;
const OWNER = 'owner-1';

function snapshot(epoch: number, file_ids: string[]): DriveChainManifest {
  return {
    snapshot_id: `od-snap-${epoch}-abc`,
    created_at: new Date(epoch),
    entries: file_ids.map((file_id) => ({
      file_id,
      drive_id: 'drive-1',
      file_name: `${file_id}.txt`,
      parent_path: '/',
      size_bytes: 1,
      storage_key: `onedrive/data/${OWNER}/${file_id}`,
      checksum: 'x',
      backup_at: new Date(epoch).toISOString(),
      change_type: 'created',
    })),
  };
}

function key_of(epoch: number): string {
  return `onedrive/manifests/${OWNER}/od-snap-${epoch}-abc.json`;
}

/** A lookup over readable snapshots plus the keys of damaged ones. */
function lookup(
  readable: DriveChainManifest[],
  unreadable_keys: string[],
): DriveManifestLookup<DriveChainManifest> {
  return {
    workload: 'OneDrive',
    find_by_snapshot: async (_ctx, _owner, id) => readable.find((m) => m.snapshot_id === id),
    list_readable_snapshots: async () => ({ manifests: readable, unreadable_keys }),
  };
}

describe('drive chain resolution with a damaged manifest (issue #631)', () => {
  const older = snapshot(1000, ['a']);
  const target = snapshot(3000, ['b']);

  it('resolves a snapshot whose chain ends before the damaged one, reporting the key', async () => {
    const chain = await load_drive_chain_entries(
      lookup([older, target], [key_of(5000)]),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    expect(chain.entries.map((row) => row.entry.file_id).sort()).toEqual(['a', 'b']);
    expect(chain.unreadable_keys).toEqual([key_of(5000)]);
  });

  it('refuses a snapshot whose chain needs an older damaged manifest, naming it', async () => {
    // Snapshot 2000's files exist nowhere else; resolving without it would silently restore a
    // drive missing them, or resurrect files it recorded as deleted.
    const resolve = load_drive_chain_entries(
      lookup([older, target], [key_of(2000)]),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    await expect(resolve).rejects.toBeInstanceOf(UnreadableObjectsError);
    await expect(resolve).rejects.toMatchObject({ unreadable_keys: [key_of(2000)] });
  });

  it('refuses when the damaged manifest was taken at the same instant as the target', async () => {
    const resolve = load_drive_chain_entries(
      lookup([older, target], [key_of(3000).replace('-abc', '-def')]),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    await expect(resolve).rejects.toBeInstanceOf(UnreadableObjectsError);
  });

  it('refuses when a damaged key carries no time, since its place in the chain is unknown', async () => {
    const legacy_key = `onedrive/manifests/${OWNER}/legacy-snapshot.json`;

    const resolve = load_drive_chain_entries(
      lookup([older, target], [legacy_key]),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    await expect(resolve).rejects.toMatchObject({ unreadable_keys: [legacy_key] });
  });

  it('reads the epoch from both providers snapshot keys', () => {
    expect(snapshot_epoch_of_key(key_of(1234))).toBe(1234);
    expect(snapshot_epoch_of_key('sharepoint/manifests/site/sp-snap-99-abc.json')).toBe(99);
    expect(snapshot_epoch_of_key('onedrive/manifests/owner/whatever.json')).toBeUndefined();
  });
});
