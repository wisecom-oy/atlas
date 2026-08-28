import { describe, expect, it } from 'vitest';
import type {
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { replicate_sharepoint_snapshot } from '@/services/replication/sharepoint-snapshot-replicator';

/**
 * Issue #191: the drive replicators had almost no unit coverage while their Outlook twin was near
 * fully covered, which is how #190 survived. These run both drive replicators through the same
 * table, so a behaviour that holds for one and not the other fails here rather than in production.
 */
const DEK_KEY = '_meta/dek.enc';
const MARKER_KEY = '_meta/replica.marker';
const MANIFEST_KEY = 'drive/manifests/scope-1/snap-1.json';

interface Recorder {
  /** Every storage call, in order, as `verb:key`. */
  readonly ops: string[];
  readonly objects: Record<string, Buffer>;
}

function make_ctx(
  recorder: Recorder,
  side: 'source' | 'target',
  fail_put_on?: string,
): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: async (key: string) => key in recorder.objects,
      get: async (key: string) => {
        const blob = recorder.objects[key];
        if (!blob) throw new Error(`missing ${key}`);
        return blob;
      },
      put: async (key: string, data: Buffer) => {
        if (side === 'target') {
          if (key === fail_put_on) throw new Error('AccessDenied');
          recorder.ops.push(`put:${key}`);
          recorder.objects[key] = data;
        }
      },
      list: async () => [],
    },
  } as unknown as TenantContext;
}

/** Source holds the DEK, the manifest and the given data keys; target starts empty. */
function make_pair(data_keys: string[], target_has: string[] = [], fail_put_on?: string) {
  const source_objects: Record<string, Buffer> = {
    [DEK_KEY]: Buffer.from('wrapped-dek'),
    [MANIFEST_KEY]: Buffer.from('{"snapshot_id":"snap-1"}'),
  };
  for (const key of data_keys) source_objects[key] = Buffer.from(`body-${key}`);

  const target: Recorder = { ops: [], objects: {} };
  for (const key of target_has) target.objects[key] = Buffer.from('already-there');

  return {
    source_ctx: make_ctx({ ops: [], objects: source_objects }, 'source'),
    target_ctx: make_ctx(target, 'target', fail_put_on),
    target,
  };
}

function od_manifest(storage_keys: string[]): OneDriveSnapshotManifest {
  return {
    snapshot_id: 'snap-1',
    owner_id: 'scope-1',
    entries: storage_keys.map((storage_key, i) => ({ item_id: `i${i}`, storage_key })),
  } as unknown as OneDriveSnapshotManifest;
}

function sp_manifest(storage_keys: string[]): SharePointSnapshotManifest {
  return {
    snapshot_id: 'snap-1',
    site_id: 'scope-1',
    entries: storage_keys.map((storage_key, i) => ({ item_id: `i${i}`, storage_key })),
  } as unknown as SharePointSnapshotManifest;
}

type Replicate = (
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: never,
  manifest_key: string,
  options?: { skip_marker?: boolean; ancillary_keys?: string[] },
) => Promise<{
  objects_copied: number;
  objects_skipped: number;
  objects_failed: number;
  errors: string[];
}>;

const workloads: [string, Replicate, (keys: string[]) => never][] = [
  ['onedrive', replicate_onedrive_snapshot as Replicate, od_manifest as (k: string[]) => never],
  ['sharepoint', replicate_sharepoint_snapshot as Replicate, sp_manifest as (k: string[]) => never],
];

describe.each(workloads)('replicate_%s_snapshot', (_name, replicate, manifest_of) => {
  it('writes the DEK, then the marker, then blobs, then ancillary keys, then the manifest', async () => {
    const ancillary = 'drive/index/scope-1/runs/r1.json';
    const { source_ctx, target_ctx, target } = make_pair([
      'drive/data/a',
      'drive/data/b',
      ancillary,
    ]);

    await replicate(
      source_ctx,
      target_ctx,
      manifest_of(['drive/data/a', 'drive/data/b']),
      MANIFEST_KEY,
      { ancillary_keys: [ancillary] },
    );

    expect(target.ops).toEqual([
      `put:${DEK_KEY}`,
      `put:${MARKER_KEY}`,
      'put:drive/data/a',
      'put:drive/data/b',
      `put:${ancillary}`,
      `put:${MANIFEST_KEY}`,
    ]);
  });

  it('the manifest is written last, because it is what makes a snapshot reachable', async () => {
    const { source_ctx, target_ctx, target } = make_pair(['drive/data/a']);

    await replicate(source_ctx, target_ctx, manifest_of(['drive/data/a']), MANIFEST_KEY);

    expect(target.ops.at(-1)).toBe(`put:${MANIFEST_KEY}`);
  });

  it('skip_marker suppresses the replica marker but still ensures the DEK', async () => {
    const { source_ctx, target_ctx, target } = make_pair(['drive/data/a']);

    await replicate(source_ctx, target_ctx, manifest_of(['drive/data/a']), MANIFEST_KEY, {
      skip_marker: true,
    });

    expect(target.ops).toContain(`put:${DEK_KEY}`);
    expect(target.ops).not.toContain(`put:${MARKER_KEY}`);
  });

  it('leaves an existing DEK alone rather than overwriting it', async () => {
    const { source_ctx, target_ctx, target } = make_pair(['drive/data/a'], [DEK_KEY]);

    await replicate(source_ctx, target_ctx, manifest_of(['drive/data/a']), MANIFEST_KEY);

    expect(target.ops).not.toContain(`put:${DEK_KEY}`);
  });

  it('counts an object already on the target as skipped and does not re-upload it', async () => {
    const { source_ctx, target_ctx, target } = make_pair(
      ['drive/data/a', 'drive/data/b'],
      ['drive/data/a'],
    );

    const result = await replicate(
      source_ctx,
      target_ctx,
      manifest_of(['drive/data/a', 'drive/data/b']),
      MANIFEST_KEY,
    );

    expect(result.objects_skipped).toBe(1);
    expect(result.objects_copied).toBe(1);
    expect(target.ops).not.toContain('put:drive/data/a');
  });

  it('tallies a failed copy and names the key in errors', async () => {
    const { source_ctx, target_ctx } = make_pair(
      ['drive/data/a', 'drive/data/b'],
      [],
      'drive/data/b',
    );

    const result = await replicate(
      source_ctx,
      target_ctx,
      manifest_of(['drive/data/a', 'drive/data/b']),
      MANIFEST_KEY,
    );

    expect(result.objects_failed).toBe(1);
    expect(result.errors).toEqual(['drive/data/b: AccessDenied']);
  });

  it('writes no manifest when a copy failed, so the next run retries the snapshot', async () => {
    const { source_ctx, target_ctx, target } = make_pair(['drive/data/a'], [], 'drive/data/a');

    await replicate(source_ctx, target_ctx, manifest_of(['drive/data/a']), MANIFEST_KEY);

    expect(target.ops).not.toContain(`put:${MANIFEST_KEY}`);
  });

  it('ignores manifest entries with no storage key', async () => {
    const { source_ctx, target_ctx, target } = make_pair(['drive/data/a']);
    const manifest = manifest_of(['drive/data/a']) as unknown as {
      entries: { item_id: string; storage_key?: string }[];
    };
    manifest.entries.push({ item_id: 'tombstone' });

    await replicate(source_ctx, target_ctx, manifest as never, MANIFEST_KEY);

    expect(target.ops.filter((op) => op.startsWith('put:drive/data/'))).toEqual([
      'put:drive/data/a',
    ]);
  });
});
