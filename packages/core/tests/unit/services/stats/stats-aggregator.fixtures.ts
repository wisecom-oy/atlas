import type { Manifest, ManifestEntry } from '@atlas/types';

export function make_entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id: 'obj-1',
    storage_key: 'data/u/abc',
    checksum: 'abc',
    size_bytes: 100,
    ...overrides,
  };
}

export function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 1,
    total_size_bytes: 100,
    delta_links: {},
    entries: [],
    ...overrides,
  };
}
