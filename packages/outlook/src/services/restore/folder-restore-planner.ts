import type { RestoreConnector } from '@atlas/types';
import type { MailboxConnector, MailFolder } from '@atlas/types';
import type { ManifestEntry } from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

const UNKNOWN_FOLDER_NAME = 'Unknown';

/**
 * Builds a mapping from Graph folder_id to display name using
 * the live folder list and the manifest's delta_links keys.
 */
export async function build_folder_map(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
): Promise<Map<string, string>> {
  const folders = await connector.list_mail_folders(tenant_id, owner_id);
  const map = new Map<string, string>();
  for (const f of folders) {
    map.set(f.folder_id, f.display_name);
  }
  return map;
}

/** Creates the `Restore-{timestamp}` root folder in the target mailbox. */
export async function create_restore_root(
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
): Promise<MailFolder> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `Restore-${ts}`;
  logger.info(`Creating restore folder: ${name}`);
  return restore_connector.create_mail_folder(tenant_id, owner_id, name);
}

/**
 * Ensures a subfolder exists under the restore root for a given folder_id.
 * Uses a cache to avoid creating the same folder twice.
 * Returns the new (restore-side) folder ID to put messages into.
 */
export async function ensure_subfolder(
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  root_folder_id: string,
  original_folder_id: string,
  folder_map: Map<string, string>,
  created_folders: Map<string, string>,
): Promise<string> {
  const cached = created_folders.get(original_folder_id);
  if (cached) return cached;

  const display_name = folder_map.get(original_folder_id) ?? UNKNOWN_FOLDER_NAME;
  const folder = await restore_connector.create_mail_folder(
    tenant_id,
    owner_id,
    display_name,
    root_folder_id,
  );

  created_folders.set(original_folder_id, folder.folder_id);
  return folder.folder_id;
}

/**
 * Groups manifest entries by folder_id. For entries without folder_id
 * (legacy manifests), falls back to extracting from decrypted message JSON.
 */
export function group_entries_by_folder(entries: ManifestEntry[]): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();

  for (const entry of entries) {
    const fid = entry.folder_id ?? '__unknown__';
    const list = groups.get(fid) ?? [];
    list.push(entry);
    groups.set(fid, list);
  }

  return groups;
}

/**
 * Filters entries belonging to a specific folder by display name.
 * Looks up the folder_id from the folder map, then filters entries.
 */
export function filter_entries_by_folder_name(
  entries: ManifestEntry[],
  folder_name: string,
  folder_map: Map<string, string>,
): ManifestEntry[] {
  const lower = folder_name.toLowerCase();
  let target_id: string | undefined;

  for (const [fid, name] of folder_map) {
    if (name.toLowerCase() === lower) {
      target_id = fid;
      break;
    }
  }

  if (!target_id) {
    const available = [...folder_map.values()].join(', ');
    logger.warn(`Folder "${folder_name}" not found. Available: ${available}`);
    return [];
  }

  return entries.filter((e) => e.folder_id === target_id);
}

/** Counts unique folder_ids across a set of entries. */
export function count_unique_folders(entries: ManifestEntry[]): number {
  const ids = new Set(entries.map((e) => e.folder_id ?? '__unknown__'));
  return ids.size;
}
