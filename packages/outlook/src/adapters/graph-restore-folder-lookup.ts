/**
 * Folder lookups a restore makes before it creates anything.
 *
 * Graph refuses a second folder with the same display name under one parent, so a restore into a
 * chosen destination has to find each level before it creates it (issue #684). Exchange compares
 * folder names case-insensitively, so `recovered` collides with an existing `Recovered`; the
 * lookup folds case the same way rather than trusting an exact match.
 */
import type { MailFolder, WellKnownMailFolder } from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import type { FolderReader } from '@/adapters/graph-recoverable-items';
import { VISIBLE_WELL_KNOWN_FOLDERS } from '@/adapters/graph-mail-folder-listing';

const CHILD_FOLDER_SELECT = 'id,displayName,parentFolderId,totalItemCount';
const CHILD_FOLDER_PAGE_SIZE = 100;

/** One Graph GET, retried by the caller's policy. */
export type GraphGet = (url: string) => Promise<unknown>;

interface GraphFolderPage {
  value?: GraphFolderRecord[];
  '@odata.nextLink'?: string;
}

/**
 * Finds a visible folder by display name directly under a parent, or under msgFolderRoot when
 * the parent is absent. Hidden folders are not listed, so a restore never reuses one and makes
 * the restored mail invisible in Outlook.
 */
export async function find_child_folder_by_name(
  get: GraphGet,
  owner_id: string,
  display_name: string,
  parent_folder_id?: string,
): Promise<MailFolder | undefined> {
  const wanted = fold_folder_name(display_name);
  let url: string | undefined = child_folders_url(owner_id, parent_folder_id);
  while (url !== undefined) {
    const page = (await get(url)) as GraphFolderPage;
    const match = page.value?.find(
      (folder) =>
        folder.displayName !== undefined && fold_folder_name(folder.displayName) === wanted,
    );
    if (match?.id !== undefined) return to_mail_folder(match, match.id, parent_folder_id);
    url = page['@odata.nextLink'];
  }
  return undefined;
}

/**
 * Returns the well-known role of a folder. Display names are localized, so the role is decided
 * by comparing the folder's id with the id Graph resolves for each well-known name. A failed read
 * propagates: the caller uses this to refuse a destination, and a guess would let one through.
 */
export async function find_well_known_role(
  read_folder: FolderReader,
  folder_id: string,
): Promise<WellKnownMailFolder | undefined> {
  // Sequential on purpose: Exchange allows four concurrent requests per mailbox.
  for (const name of VISIBLE_WELL_KNOWN_FOLDERS) {
    if ((await read_folder(name))?.id === folder_id) return name;
  }
  return undefined;
}

/** Folds a folder name the way Exchange compares them: case-insensitively. */
export function fold_folder_name(name: string): string {
  return name.toLowerCase();
}

function child_folders_url(owner_id: string, parent_folder_id?: string): string {
  const collection = parent_folder_id
    ? `/users/${owner_id}/mailFolders/${parent_folder_id}/childFolders`
    : `/users/${owner_id}/mailFolders`;
  return `${collection}?$select=${CHILD_FOLDER_SELECT}&$top=${CHILD_FOLDER_PAGE_SIZE}`;
}

function to_mail_folder(
  record: GraphFolderRecord,
  folder_id: string,
  parent_folder_id: string | undefined,
): MailFolder {
  const display_name = record.displayName ?? '';
  return {
    folder_id,
    display_name,
    folder_path: display_name,
    parent_folder_id: record.parentFolderId ?? parent_folder_id,
    total_item_count: record.totalItemCount ?? 0,
  };
}
