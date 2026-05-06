import { describe, it, expect } from 'vitest';
import {
  merge_snapshot_entries,
  filter_manifests_by_date,
} from '@/services/restore/manifest-entry-merger';
import type { Manifest, ManifestEntry } from '@atlas/types';

function make_entry(id: string, folder_id = 'f1'): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: id,
    size_bytes: 100,
    folder_id,
  };
}

function make_manifest(
  snapshot_id: string,
  created_at: string,
  entries: ManifestEntry[],
): Manifest {
  return {
    id: `manifest-${snapshot_id}`,
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

describe('merge_snapshot_entries', () => {
  it('merges entries from multiple manifests', () => {
    const m1 = make_manifest('s1', '2026-03-08', [make_entry('a'), make_entry('b')]);
    const m2 = make_manifest('s2', '2026-03-07', [make_entry('c'), make_entry('d')]);

    const result = merge_snapshot_entries([m1, m2]);
    expect(result).toHaveLength(4);
    expect(result.map((e) => e.object_id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('deduplicates by object_id, newest manifest wins', () => {
    const m_new = make_manifest('s1', '2026-03-08', [make_entry('a'), make_entry('b')]);
    const m_old = make_manifest('s2', '2026-03-07', [make_entry('b'), make_entry('c')]);

    const result = merge_snapshot_entries([m_new, m_old]);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.object_id)).toEqual(['a', 'b', 'c']);
    expect(result[1]!.storage_key).toBe('data/user/b');
  });

  it('returns empty for empty manifests', () => {
    const m = make_manifest('s1', '2026-03-08', []);
    expect(merge_snapshot_entries([m])).toHaveLength(0);
  });

  it('returns empty for no manifests', () => {
    expect(merge_snapshot_entries([])).toHaveLength(0);
  });

  it('preserves all entries when no duplicates', () => {
    const m1 = make_manifest('s1', '2026-03-08', [make_entry('a')]);
    const m2 = make_manifest('s2', '2026-03-07', [make_entry('b')]);
    const m3 = make_manifest('s3', '2026-03-06', [make_entry('c')]);

    const result = merge_snapshot_entries([m1, m2, m3]);
    expect(result).toHaveLength(3);
  });
});

describe('filter_manifests_by_date', () => {
  const m1 = make_manifest('s1', '2026-03-01T12:00:00Z', [make_entry('a')]);
  const m2 = make_manifest('s2', '2026-03-05T12:00:00Z', [make_entry('b')]);
  const m3 = make_manifest('s3', '2026-03-10T12:00:00Z', [make_entry('c')]);
  const all = [m1, m2, m3];

  it('returns all when no date filters', () => {
    const result = filter_manifests_by_date(all);
    expect(result).toHaveLength(3);
  });

  it('filters by start_date', () => {
    const result = filter_manifests_by_date(all, new Date('2026-03-05'));
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.snapshot_id)).toEqual(['s2', 's3']);
  });

  it('filters by end_date', () => {
    const result = filter_manifests_by_date(all, undefined, new Date('2026-03-05'));
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.snapshot_id)).toEqual(['s1', 's2']);
  });

  it('filters by both start and end date', () => {
    const result = filter_manifests_by_date(all, new Date('2026-03-02'), new Date('2026-03-08'));
    expect(result).toHaveLength(1);
    expect(result[0]!.snapshot_id).toBe('s2');
  });

  it('returns empty when no manifests in range', () => {
    const result = filter_manifests_by_date(all, new Date('2026-04-01'));
    expect(result).toHaveLength(0);
  });
});
