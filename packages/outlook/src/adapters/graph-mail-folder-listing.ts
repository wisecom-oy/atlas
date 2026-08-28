import type { MailFolder, MailFolderListOptions } from '@wisecom/atlas-types';
import { enumerate_folder_tree } from '@/adapters/graph-folder-tree-enumerator';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';

const FOLDER_SELECT = 'id,displayName,parentFolderId,totalItemCount,childFolderCount,isHidden';
const FOLDER_PAGE_SIZE = 250;

/** Fetches every page of one Graph collection, retrying each page on its own. */
export type FolderPageFetcher = (url: string) => Promise<GraphFolderRecord[]>;

/**
 * Lists every mail folder in a mailbox, at any nesting depth.
 *
 * Hidden folders are requested explicitly. `/mailFolders` and
 * `/childFolders` both omit them unless `includeHiddenFolders=true` is passed,
 * so without it a folder Exchange marks hidden is invisible to backup on every
 * tenant, whatever it contains. Which hidden folders are worth keeping is the
 * enumerator's decision, not the request's.
 */
export async function list_mail_folder_tree(
  fetch_page: FolderPageFetcher,
  owner_id: string,
  options?: MailFolderListOptions,
): Promise<MailFolder[]> {
  // Per-page retry lives inside the fetcher; wrapping the whole enumeration
  // would put every page under one 60s timeout.
  return await enumerate_folder_tree(
    (parent_folder_id) => fetch_page(folder_url(owner_id, parent_folder_id)),
    options,
  );
}

/** Builds the folder-collection URL for the mailbox root or one parent folder. */
export function folder_url(owner_id: string, parent_folder_id?: string): string {
  const collection = parent_folder_id
    ? `/users/${owner_id}/mailFolders/${parent_folder_id}/childFolders`
    : `/users/${owner_id}/mailFolders`;
  return `${collection}?includeHiddenFolders=true&$select=${FOLDER_SELECT}&$top=${FOLDER_PAGE_SIZE}`;
}
