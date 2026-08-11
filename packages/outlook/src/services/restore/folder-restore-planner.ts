import type { RestoreConnector } from '@wisecom/atlas-types';
import type { MailboxConnector, MailFolder } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { FOLDER_PATH_SEPARATOR } from '@/adapters/graph-folder-tree-enumerator';
import { folder_matches_selector } from '@/services/shared/folder-selector';

const UNKNOWN_FOLDER_NAME = 'Unknown';

/**
 * Builds a mapping from Graph folder_id to the folder's root-relative path
 * (e.g. `Inbox/Projects/2026`), so nested folders stay distinguishable in
 * restore targets, save archives, and folder filters.
 */
export async function build_folder_map(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
): Promise<Map<string, string>> {
  const folders = await connector.list_mail_folders(tenant_id, owner_id);
  const map = new Map<string, string>();
  for (const f of folders) {
    map.set(f.folder_id, f.folder_path);
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
 * Ensures the restore-side folder for a given original folder_id exists,
 * recreating the source nesting (`Inbox/Projects/2026`) as real subfolders of
 * the restore root. Every level is cached by its path, so sibling folders
 * sharing a parent create that parent once.
 * Returns the restore-side folder ID to put messages into.
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

  const folder_path = folder_map.get(original_folder_id) ?? UNKNOWN_FOLDER_NAME;
  let parent_id = root_folder_id;
  let path_so_far = '';

  for (const segment of folder_path.split(FOLDER_PATH_SEPARATOR)) {
    path_so_far = path_so_far ? `${path_so_far}${FOLDER_PATH_SEPARATOR}${segment}` : segment;
    const existing = created_folders.get(path_so_far);
    if (existing) {
      parent_id = existing;
      continue;
    }
    const folder = await restore_connector.create_mail_folder(
      tenant_id,
      owner_id,
      segment,
      parent_id,
    );
    created_folders.set(path_so_far, folder.folder_id);
    parent_id = folder.folder_id;
  }

  created_folders.set(original_folder_id, parent_id);
  return parent_id;
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
 * Filters entries to a folder selected by path (`Inbox/Projects`) or bare name
 * (`Projects`), including everything nested beneath the match.
 */
export function filter_entries_by_folder_name(
  entries: ManifestEntry[],
  folder_name: string,
  folder_map: Map<string, string>,
): ManifestEntry[] {
  const target_ids = new Set<string>();
  for (const [fid, path] of folder_map) {
    if (folder_matches_selector(path, folder_name)) target_ids.add(fid);
  }

  if (target_ids.size === 0) {
    const available = [...folder_map.values()].join(', ');
    logger.warn(`Folder "${folder_name}" not found. Available: ${available}`);
    return [];
  }

  return entries.filter((e) => e.folder_id !== undefined && target_ids.has(e.folder_id));
}

/** Counts unique folder_ids across a set of entries. */
export function count_unique_folders(entries: ManifestEntry[]): number {
  const ids = new Set(entries.map((e) => e.folder_id ?? '__unknown__'));
  return ids.size;
}
