import type { ContactFolder, Manifest, StoredContactEntry } from '@wisecom/atlas-types';

/** Resolves the latest contact state through manifests sorted newest-first. */
export function resolve_contact_snapshot(manifests: Manifest[]): {
  folders: ContactFolder[];
  entries: StoredContactEntry[];
} {
  const newest = manifests.find((manifest) => manifest.contact_folders !== undefined);
  const folders = newest?.contact_folders ?? [];
  const active_folders = new Set(folders.map((folder) => folder.folder_id));
  const seen = new Set<string>();
  const entries: StoredContactEntry[] = [];
  for (const manifest of manifests) {
    for (const entry of manifest.contact_entries ?? []) {
      if (entry.change_type !== 'stored' || seen.has(entry.contact_id)) continue;
      seen.add(entry.contact_id);
      if (active_folders.has(entry.folder_id)) entries.push(entry);
    }
    for (const entry of manifest.contact_entries ?? []) {
      if (entry.change_type === 'deleted') seen.add(entry.contact_id);
    }
  }
  return { folders, entries };
}
