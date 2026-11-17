import type { ContactFolderRecord, ContactsConnector } from '@wisecom/atlas-types';

import { error_message } from '@/services/shared/error-message';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

/** Source-to-target folder mapping produced before any contact is written. */
export interface FolderMapping {
  /** Target folder id keyed by source folder id. */
  readonly target_by_source: ReadonlyMap<string, string>;
  readonly folders_created: number;
  readonly errors: string[];
}

/**
 * Keys folders by their display-name chain, which is how source and target trees line up.
 * Exchange compares folder names without case and rejects a sibling that differs only in case,
 * so the key does too: a target folder named `sub` receives a source folder named `Sub`.
 */
function path_key(path: readonly string[]): string {
  return JSON.stringify(path.map((name) => name.toLowerCase()));
}

/**
 * Maps each source folder onto the target mailbox, creating missing folders parent-first.
 * The default folder (empty path) maps to the target's default Contacts folder.
 */
export async function map_source_folders(
  connector: ContactsConnector,
  target: { readonly tenant_id: string; readonly mailbox_id: string },
  source_folders: readonly ContactFolderRecord[],
): Promise<FolderMapping> {
  const existing = await connector.list_contact_folders(target.tenant_id, target.mailbox_id);
  const path_ids = new Map<string, string>(
    existing.map((folder) => [path_key(folder.path), folder.id]),
  );
  const target_by_source = new Map<string, string>();
  const errors: string[] = [];
  let folders_created = 0;

  const ordered = [...source_folders].sort((a, b) => a.path.length - b.path.length);
  for (const folder of ordered) {
    const found = path_ids.get(path_key(folder.path));
    if (found !== undefined) {
      target_by_source.set(folder.folder_id, found);
      continue;
    }
    const parent_id = path_ids.get(path_key(folder.path.slice(0, -1)));
    if (parent_id === undefined) {
      errors.push(`Contacts folder ${folder.display_name} has no restored parent folder`);
      continue;
    }
    try {
      const created = await connector.create_contact_folder(
        target.tenant_id,
        target.mailbox_id,
        parent_id,
        folder.display_name,
      );
      path_ids.set(path_key(folder.path), created.id);
      target_by_source.set(folder.folder_id, created.id);
      folders_created += 1;
    } catch (err) {
      if (is_run_fatal(err)) throw err;
      errors.push(
        `Contacts folder ${folder.display_name} could not be created: ${error_message(err)}`,
      );
    }
  }

  return { target_by_source, folders_created, errors };
}
