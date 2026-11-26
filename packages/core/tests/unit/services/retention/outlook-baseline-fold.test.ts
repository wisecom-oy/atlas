import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';
import {
  fold_outlook_baseline,
  outlook_baseline_matches,
} from '@/services/retention/outlook-baseline-fold';
import { merge_snapshot_entries } from '@/services/shared/manifest-entry-merger';

function entry(object_id: string, version = 1): ManifestEntry {
  return { object_id, storage_key: `data/o/${object_id}-${version}`, checksum: 'x', size_bytes: 3 };
}

function manifest(id: string, entries: ManifestEntry[], extra: Partial<Manifest> = {}): Manifest {
  return {
    id,
    tenant_id: 't',
    owner_id: 'o',
    snapshot_id: id,
    created_at: new Date(0),
    total_objects: 7,
    total_size_bytes: 0,
    delta_links: { inbox: 'link' },
    entries,
    ...extra,
  };
}

describe('fold_outlook_baseline', () => {
  const older = manifest('p1', [entry('a'), entry('b'), entry('c')], {
    folders: [{ folder_id: 'f1', display_name: 'Old', folder_path: 'Old', total_item_count: 1 }],
  });
  const newer = manifest('p2', [entry('b', 2)], { removed_object_ids: ['c'] });
  const target = manifest('k', [entry('d')], { removed_object_ids: ['a'] });

  it('holds exactly the entries the chain merges to, newest version first', () => {
    const chain = [target, newer, older];
    const baseline = fold_outlook_baseline(chain);
    expect(baseline.entries).toEqual(merge_snapshot_entries(chain));
    expect(baseline.snapshot_id).toBe('k');
    expect(baseline.delta_links).toEqual({ inbox: 'link' });
    expect(baseline.total_objects).toBe(7);
    expect(baseline.total_size_bytes).toBe(6);
    expect(baseline.folders?.map((f) => f.folder_id)).toEqual(['f1']);
  });

  it('records a removal for every older message it hides, so a surviving older manifest stays hidden', () => {
    const baseline = fold_outlook_baseline([target, newer, older]);
    expect(baseline.removed_object_ids?.sort()).toEqual(['a', 'c']);
    // An older manifest Object Lock kept still follows the baseline in every chain.
    expect(merge_snapshot_entries([baseline, older])).toEqual(baseline.entries);
    expect(merge_snapshot_entries([baseline, newer, older])).toEqual(baseline.entries);
  });

  it('folds a stored baseline with what is left of its chain into the same baseline', () => {
    const baseline = fold_outlook_baseline([target, newer, older]);
    expect(outlook_baseline_matches(baseline, fold_outlook_baseline([baseline, older]))).toBe(true);
    expect(outlook_baseline_matches(baseline, fold_outlook_baseline([baseline]))).toBe(true);
    expect(outlook_baseline_matches(target, baseline)).toBe(false);
  });

  it('omits empty removals and folders, as a backup writes a manifest', () => {
    const baseline = fold_outlook_baseline([
      manifest('k', [entry('a')]),
      manifest('p', [entry('a', 0)]),
    ]);
    expect(baseline).not.toHaveProperty('removed_object_ids');
    expect(baseline).not.toHaveProperty('folders');
  });
});
