import { vi } from 'vitest';
import type { Manifest, ManifestEntry, ObjectStorage } from '@wisecom/atlas-types';

export function make_entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id: 'obj-1',
    storage_key: 'data/mailbox/key-1',
    checksum: '',
    size_bytes: 0,
    ...overrides,
  };
}

export function make_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    owner_id: 'mailbox-1',
    snapshot_id: 'snapshot-1',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

export function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn(),
    list_stale: vi.fn(async () => []),
    list: vi.fn(),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    get_with_etag: vi.fn(),
    get_stream: vi.fn(),
    apply_default_retention: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  };
}
