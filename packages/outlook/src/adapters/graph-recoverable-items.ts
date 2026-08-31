/**
 * Enumeration of the Exchange Recoverable Items subtree, the "dumpster".
 *
 * It is not reachable from `/users/{id}/mailFolders`, which returns the
 * children of the Top of Information Store. The dumpster is a sibling of that
 * root, so a mailbox backup walking only the visible tree cannot see it, and
 * anything hard-deleted between two runs exists nowhere else in the tenant
 * (issue #141).
 *
 * The root is located through the one well-known name Microsoft documents for
 * this subtree, `recoverableitemsdeletions`, and its `parentFolderId`.
 * `recoverableitemsroot` and `recoverableitemspurges` do answer today but
 * appear in no published list of well-known folder names, so relying on them
 * would build on undocumented behaviour.
 *
 * @see https://learn.microsoft.com/en-us/exchange/security-and-compliance/recoverable-items-folder/recoverable-items-folder
 */

import type { ExcludedFolder, MailFolder, MailFolderListOptions } from '@wisecom/atlas-types';
import type { GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';
import { enumerate_folder_tree } from '@/adapters/graph-folder-tree-enumerator';
import { logger } from '@wisecom/atlas-core/utils/logger';

/** Path prefix given to every folder in the subtree, so manifests stay readable. */
export const RECOVERABLE_ITEMS_PATH_PREFIX = 'Recoverable Items';

/** The documented well-known name that anchors the subtree. */
export const RECOVERABLE_ITEMS_ANCHOR = 'recoverableitemsdeletions';

/**
 * Subfolders holding mail items, which back up exactly like ordinary messages.
 *
 * `DiscoveryHolds` is included although issue #141 does not list it: it holds
 * hard-deleted items under an In-Place Hold or a retention policy, which is the
 * same content as `Purges` arriving through a different hold, and omitting it
 * would leave the compliance gap the flag exists to close.
 */
const MAIL_SUBFOLDERS: Record<string, true> = {
  deletions: true,
  purges: true,
  discoveryholds: true,
  substrateholds: true,
};

/**
 * Subfolders that are not mail and are deliberately not captured.
 *
 * `Versions` holds pre-modification copies whose item shape differs from a
 * message, `Calendar Logging` is a calendar audit trail, and `Audits` is
 * mailbox audit log entries. Each is reported rather than dropped quietly.
 */
const NON_MAIL_SUBFOLDERS: Record<string, true> = {
  versions: true,
  'calendar logging': true,
  audits: true,
};

/** Reads one mail folder by id or well-known name; undefined when absent. */
export type FolderReader = (folder_ref: string) => Promise<GraphFolderRecord | undefined>;

/**
 * Enumerates the Recoverable Items subfolders that hold mail.
 *
 * Returns an empty list when the subtree cannot be resolved, which is the
 * normal answer for a mailbox that has never had one, and reports every
 * subfolder it declined to capture through `on_excluded`.
 */
export async function enumerate_recoverable_items(
  read_folder: FolderReader,
  fetch_children: (parent_folder_id: string) => Promise<GraphFolderRecord[]>,
  options: MailFolderListOptions = {},
): Promise<MailFolder[]> {
  const root_id = await resolve_recoverable_items_root(read_folder);
  if (!root_id) return [];

  const children = await fetch_children(root_id);
  const captured: MailFolder[] = [];

  for (const child of children) {
    if (!child.id) continue;
    const display_name = child.displayName ?? '';
    const folder_path = `${RECOVERABLE_ITEMS_PATH_PREFIX}/${display_name}`;
    const reason = subfolder_exclusion_reason(display_name);
    if (reason) {
      options.on_excluded?.({ folder_path, reason });
      continue;
    }

    captured.push({
      folder_id: child.id,
      display_name,
      folder_path,
      parent_folder_id: root_id,
      total_item_count: child.totalItemCount ?? 0,
      is_recoverable_items: true,
      ...(child.isHidden === true ? { is_hidden: true } : {}),
    });

    // Same rule as the visible tree: only a folder that reports children costs
    // a request. Descending unconditionally would spend four per mailbox per
    // run for subtrees that are almost always empty.
    if ((child.childFolderCount ?? 0) === 0) continue;

    const subtree = await enumerate_folder_tree(
      (parent_folder_id) => fetch_children(parent_folder_id ?? child.id!),
      options,
      { root_path: [RECOVERABLE_ITEMS_PATH_PREFIX, display_name] },
    );
    captured.push(...subtree.map((folder) => ({ ...folder, is_recoverable_items: true })));
  }

  return captured;
}

/** Locates the subtree root through the anchor folder's parent. */
async function resolve_recoverable_items_root(
  read_folder: FolderReader,
): Promise<string | undefined> {
  const anchor = await read_folder(RECOVERABLE_ITEMS_ANCHOR);
  if (!anchor?.parentFolderId) {
    logger.debug(
      'Recoverable Items root could not be resolved; the mailbox reports no Deletions folder.',
    );
    return undefined;
  }
  return anchor.parentFolderId;
}

/**
 * Decides whether a subfolder of the dumpster is captured, and why not.
 *
 * An unrecognised name is reported rather than captured or ignored. These
 * subfolder names are not localised the way Inbox and Drafts are, but that is
 * observed behaviour rather than a documented guarantee, so a mailbox that
 * presents different names produces a visible gap instead of a silent one.
 */
function subfolder_exclusion_reason(display_name: string): ExcludedFolder['reason'] | undefined {
  const name = display_name.toLowerCase();
  if (MAIL_SUBFOLDERS[name]) return undefined;
  if (NON_MAIL_SUBFOLDERS[name]) return 'recoverable-items-not-mail';
  return 'recoverable-items-unrecognised';
}
