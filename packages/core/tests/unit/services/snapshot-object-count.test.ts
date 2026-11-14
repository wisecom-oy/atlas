import { describe, it, expect } from 'vitest';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';
import { merge_snapshot_entries } from '@/services/shared/manifest-entry-merger';
import {
  count_merged_objects,
  count_objects_after_run,
  count_objects_by_snapshot,
} from '@/services/catalog/snapshot-object-count';
import { make_manifest, summary_listing } from './catalog-service.fixtures';

function entries(...object_ids: string[]): ManifestEntry[] {
  return object_ids.map((object_id) => ({
    object_id,
    storage_key: `data/${object_id}`,
    checksum: object_id,
    size_bytes: 1,
  }));
}

function run(
  snapshot_id: string,
  day: number,
  object_ids: string[],
  removed_object_ids?: string[],
): Manifest {
  return make_manifest({
    snapshot_id,
    created_at: new Date(Date.UTC(2026, 2, day)),
    total_objects: 0,
    entries: entries(...object_ids),
    ...(removed_object_ids ? { removed_object_ids } : {}),
  });
}

/** The entry count `verify`, `restore -s` and `save -s` read for the chain each run heads. */
function merged_count_at(runs: readonly Manifest[], snapshot_id: string): number {
  const target = runs.find((m) => m.snapshot_id === snapshot_id)!;
  const chain = runs
    .filter((m) => m.created_at.getTime() <= target.created_at.getTime())
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return merge_snapshot_entries(chain).length;
}

function rows(runs: readonly Manifest[]) {
  return summary_listing([...runs].reverse()).summaries;
}

// Issue #711: a run with Recoverable Items, a full run without them, then an incremental that adds
// messages and re-reads one it already had.
const with_recoverable = run('s1', 1, ['a', 'b', 'c', 'rd1', 'rd2']);
const full_without = run('s2', 2, ['a', 'b', 'c']);
const incremental = run('s3', 3, ['d', 'e', 'a']);

describe('count_objects_by_snapshot', () => {
  it('counts each snapshot as the chain verify reads, not as one run', () => {
    const runs = [with_recoverable, full_without, incremental];

    const counts = count_objects_by_snapshot(rows(runs));

    expect(counts.get('s1')).toBe(5);
    expect(counts.get('s2')).toBe(5);
    expect(counts.get('s3')).toBe(7);
    for (const m of runs)
      expect(counts.get(m.snapshot_id)).toBe(merged_count_at(runs, m.snapshot_id));
  });

  it('falls when a later run records removals', () => {
    const runs = [with_recoverable, run('s2', 2, [], ['b', 'rd1'])];

    const counts = count_objects_by_snapshot(rows(runs));

    expect(counts.get('s1')).toBe(5);
    expect(counts.get('s2')).toBe(3);
    expect(counts.get('s2')).toBe(merged_count_at(runs, 's2'));
  });

  it('keeps a message one run both removed and recorded, as a move between folders', () => {
    const runs = [run('s1', 1, ['a', 'b']), run('s2', 2, ['a'], ['a'])];

    expect(count_objects_by_snapshot(rows(runs)).get('s2')).toBe(2);
    expect(merged_count_at(runs, 's2')).toBe(2);
  });

  it('counts a message removed and later captured again', () => {
    const runs = [run('s1', 1, ['a', 'b']), run('s2', 2, [], ['a']), run('s3', 3, ['a'])];

    const counts = count_objects_by_snapshot(rows(runs));

    expect([counts.get('s1'), counts.get('s2'), counts.get('s3')]).toEqual([2, 1, 2]);
    expect(counts.get('s3')).toBe(merged_count_at(runs, 's3'));
  });

  it('agrees with count_merged_objects for the newest snapshot', () => {
    const listing = rows([with_recoverable, full_without, incremental]);

    expect(count_objects_by_snapshot(listing).get('s3')).toBe(count_merged_objects(listing));
  });
});

describe('count_objects_after_run', () => {
  const previous_rows = rows([with_recoverable, full_without]);

  it('tops the existing chain with the manifest the run writes', () => {
    expect(count_objects_after_run(previous_rows, incremental)).toBe(7);
  });

  it('reports the head chain for a quiet run', () => {
    expect(count_objects_after_run(previous_rows, undefined)).toBe(5);
  });

  it('counts a first run on its own entries', () => {
    expect(count_objects_after_run([], run('s1', 1, ['a', 'a', 'b']))).toBe(2);
  });

  it('subtracts the removals the run records', () => {
    expect(count_objects_after_run(previous_rows, run('s3', 3, [], ['rd1', 'rd2']))).toBe(3);
  });
});
