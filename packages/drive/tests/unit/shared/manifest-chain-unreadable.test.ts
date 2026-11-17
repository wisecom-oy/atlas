import { describe, expect, it } from 'vitest';
import type { SnapshotSummary, TenantContext } from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  load_drive_chain_entries,
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

function summary_of(manifest: DriveChainManifest): SnapshotSummary {
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key: key_of(manifest.created_at.getTime()),
    entry_count: manifest.entries.length,
    total_size_bytes: 0,
  };
}

/**
 * A lookup whose summary index lists `readable` plus rows for `damaged_rows`, which fail to
 * decrypt, and names `unreadable_keys` as rowless manifests that failed to decrypt. `reads`
 * collects every manifest key the chain reads.
 */
function lookup(
  readable: DriveChainManifest[],
  unreadable_keys: string[],
  damaged_rows: SnapshotSummary[] = [],
  reads: string[] = [],
): DriveManifestLookup<DriveChainManifest> {
  return {
    workload: 'OneDrive',
    find_by_snapshot: async (_ctx, _owner, id) => readable.find((m) => m.snapshot_id === id),
    list_snapshot_summaries: async () => ({
      summaries: [...readable.map(summary_of), ...damaged_rows],
      unreadable_keys,
    }),
    read_manifest_at: async (_ctx, key) => {
      reads.push(key);
      if (damaged_rows.some((row) => row.manifest_key === key)) {
        throw new UnreadableObjectsError('damaged', [key]);
      }
      return readable.find((m) => key_of(m.created_at.getTime()) === key);
    },
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

  it('decrypts only the manifests at or before the target (#625)', async () => {
    const newer = snapshot(9000, ['c']);
    const reads: string[] = [];

    await load_drive_chain_entries(
      lookup([older, target, newer], [], [], reads),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    expect(reads).toEqual([key_of(1000)]);
  });

  it('refuses when a manifest the summary places in the chain is damaged, naming it', async () => {
    const damaged = summary_of(snapshot(2000, []));

    const resolve = load_drive_chain_entries(
      lookup([older, target], [], [damaged]),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    await expect(resolve).rejects.toMatchObject({ unreadable_keys: [key_of(2000)] });
  });

  it('ignores a damaged manifest the summary places after the target', async () => {
    const damaged = summary_of(snapshot(5000, []));

    const chain = await load_drive_chain_entries(
      lookup([older, target], [], [damaged]),
      CTX,
      OWNER,
      target.snapshot_id,
    );

    expect(chain.entries.map((row) => row.entry.file_id).sort()).toEqual(['a', 'b']);
  });
});
