import type { MailFolder, MailFolderListOptions } from '@wisecom/atlas-types';
import { enumerate_folder_tree } from '@/adapters/graph-folder-tree-enumerator';
import { enumerate_recoverable_items, type FolderReader } from '@/adapters/graph-recoverable-items';
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
  read_folder?: FolderReader,
): Promise<MailFolder[]> {
  // Per-page retry lives inside the fetcher; wrapping the whole enumeration
  // would put every page under one 60s timeout.
  const visible = await enumerate_folder_tree(
    (parent_folder_id) => fetch_page(folder_url(owner_id, parent_folder_id)),
    options,
  );

  // Off by default, and when off this costs not one extra request.
  if (options?.include_recoverable_items !== true || !read_folder) return visible;

  const recoverable = await enumerate_recoverable_items(
    read_folder,
    (parent_folder_id) => fetch_page(folder_url(owner_id, parent_folder_id)),
    options,
  );
  return [...visible, ...recoverable];
}

/** Builds the folder-collection URL for the mailbox root or one parent folder. */
export function folder_url(owner_id: string, parent_folder_id?: string): string {
  const collection = parent_folder_id
    ? `/users/${owner_id}/mailFolders/${parent_folder_id}/childFolders`
    : `/users/${owner_id}/mailFolders`;
  return `${collection}?includeHiddenFolders=true&$select=${FOLDER_SELECT}&$top=${FOLDER_PAGE_SIZE}`;
}

/** Builds the URL that reads one folder by id or well-known name. */
export function folder_read_url(owner_id: string, folder_ref: string): string {
  return `/users/${owner_id}/mailFolders/${folder_ref}?$select=id,displayName,parentFolderId`;
}

/**
 * Wraps a raw Graph GET as a {@link FolderReader}.
 *
 * A mailbox with no Recoverable Items subtree answers 404 for the anchor
 * folder, which is an answer rather than a failure, so it maps to undefined
 * here instead of aborting a backup.
 */
export function create_folder_reader(
  get_one: (url: string) => Promise<unknown>,
  owner_id: string,
): FolderReader {
  return async (folder_ref: string) => {
    try {
      return (await get_one(folder_read_url(owner_id, folder_ref))) as GraphFolderRecord;
    } catch (err) {
      if ((err as Record<string, unknown>).statusCode === 404) return undefined;
      throw err;
    }
  };
}
