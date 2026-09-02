import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';

/** Builds a minimal Outlook manifest entry for restore service tests. */
export function make_restore_entry(id: string, folder_id: string): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: id,
    size_bytes: 100,
    subject: `Subject ${id}`,
    folder_id,
  };
}

/** Builds a minimal Outlook manifest for restore service tests. */
export function make_restore_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date(),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

/** Builds the encrypted-message fixture consumed by the restore service tests. */
export function make_stored_message(folder_id: string): Buffer {
  const json = JSON.stringify({
    subject: 'Hello',
    body: { contentType: 'Text', content: 'Hello world' },
    parentFolderId: folder_id,
    receivedDateTime: '2026-01-01T00:00:00Z',
    isRead: true,
  });
  return Buffer.concat([Buffer.from('E'), Buffer.from(json)]);
}
