import { randomBytes } from 'node:crypto';
import type {
  ContactFolderRecord,
  ContactManifestEntry,
  ContactsSnapshotManifest,
} from '@wisecom/atlas-types';

/** Counts of contacts added or changed, and of contacts that disappeared, between two states. */
export interface EntryChangeCounts {
  readonly changed: number;
  readonly removed: number;
}

/** Compares final entries with the previous snapshot's entries, by contact id. */
export function compare_entries(
  previous: readonly ContactManifestEntry[],
  entries: readonly ContactManifestEntry[],
): EntryChangeCounts {
  const prior_by_id = new Map<string, ContactManifestEntry>(
    previous.map((entry) => [entry.contact_id, entry]),
  );
  const current_ids = new Set(entries.map((entry) => entry.contact_id));
  let changed = 0;
  for (const entry of entries) {
    const prior = prior_by_id.get(entry.contact_id);
    const unchanged =
      prior !== undefined &&
      prior.folder_id === entry.folder_id &&
      prior.storage_key === entry.storage_key &&
      prior.photo_storage_key === entry.photo_storage_key;
    if (!unchanged) changed += 1;
  }
  let removed = 0;
  for (const id of prior_by_id.keys()) {
    if (!current_ids.has(id)) removed += 1;
  }
  return { changed, removed };
}

/** Whether the folder tree differs from the previous snapshot's; no previous snapshot means no difference. */
export function folders_differ(
  previous: readonly ContactFolderRecord[] | undefined,
  folders: readonly ContactFolderRecord[],
): boolean {
  if (previous === undefined) return false;
  return JSON.stringify(previous) !== JSON.stringify(folders);
}

/** Builds a snapshot id of the form `ct-snap-<ms>-<hex>`. */
export function new_snapshot_id(now_ms: number): string {
  return `ct-snap-${now_ms}-${randomBytes(3).toString('hex')}`;
}

/** Assembles a full, self-contained manifest from the final entry set. */
export function build_snapshot_manifest(input: {
  readonly tenant_id: string;
  readonly mailbox_id: string;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly folders: readonly ContactFolderRecord[];
  readonly entries: readonly ContactManifestEntry[];
}): ContactsSnapshotManifest {
  const total_size_bytes = input.entries.reduce(
    (sum, entry) => sum + entry.size_bytes + (entry.photo_size_bytes ?? 0),
    0,
  );
  return {
    id: input.snapshot_id,
    tenant_id: input.tenant_id,
    mailbox_id: input.mailbox_id,
    snapshot_id: input.snapshot_id,
    created_at: input.created_at.toISOString(),
    total_contacts: input.entries.length,
    total_size_bytes,
    folders: [...input.folders],
    entries: [...input.entries],
  };
}
