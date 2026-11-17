/**
 * Names a backup's folders from what its manifests recorded, so restore and save work for a
 * mailbox Graph can no longer answer for: a departed user, or a cross-tenant restore whose
 * connector signs in to the target tenant (issue #713). The source mailbox is listed only when
 * the manifests fall short, as those written before folders were recorded do.
 */
import { MailboxNotLicensedError, NotFoundError } from '@wisecom/atlas-types';
import type { MailboxConnector, MailFolder, Manifest, ManifestEntry } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { folder_listing_for } from '@/services/restore/recoverable-items-filter';
import { select_folders, type SelectableFolder } from '@/services/shared/folder-selector';

/** The source mailbox, and the manifests whose recorded folders name its folders. */
export interface SourceFolders {
  readonly connector: MailboxConnector;
  readonly tenant_id: string;
  readonly owner_id: string;
  /** The first manifest that records a folder names it, so pass the most relevant first. */
  readonly manifests: readonly Manifest[];
}

/** Recorded folders by `folder_id`. */
type FolderCatalog = Map<string, SelectableFolder>;

/**
 * Maps each folder_id to its root-relative path (`Inbox/Projects/2026`). The recorded paths
 * suffice when they name the folder of every entry. Otherwise the source mailbox names the rest,
 * and a listing that fails ends the run, since restoring without paths would scatter the mail.
 * Pass entries whose `folder_id` is already backfilled.
 */
export async function resolve_folder_paths(
  source: SourceFolders,
  entries: readonly ManifestEntry[],
): Promise<Map<string, string>> {
  const catalog = collect_recorded_folders(source.manifests);
  const unrecorded = count_unrecorded_folders(catalog, entries);
  if (unrecorded > 0) {
    add_live_folders(catalog, await list_folders_for_unrecorded(source, entries, unrecorded));
  }
  return new Map([...catalog.values()].map((folder) => [folder.folder_id, folder.folder_path]));
}

/**
 * The folders a `--folder` selector is matched against. The recorded folders, when they name the
 * folder of every entry and the selector matches one of them. Otherwise the source mailbox is
 * listed too, for folders the manifests do not record and for roles a backup could not tag. A
 * selector that matches nothing recorded is then matched against the recorded folders alone when
 * that listing fails, so the caller's not-found error names what the backup holds.
 */
export async function list_selectable_folders(
  source: SourceFolders,
  entries: readonly ManifestEntry[],
  selector: string,
): Promise<SelectableFolder[]> {
  const catalog = collect_recorded_folders(source.manifests);
  const unrecorded = count_unrecorded_folders(catalog, entries);
  if (unrecorded > 0) {
    add_live_folders(catalog, await list_folders_for_unrecorded(source, entries, unrecorded));
  } else if (select_folders([...catalog.values()], selector).length === 0) {
    add_live_folders(catalog, await list_folders_for_unmatched(source, entries, selector));
  }
  return [...catalog.values()];
}

/** Collects each folder the manifests record, the first manifest naming a folder winning. */
function collect_recorded_folders(manifests: readonly Manifest[]): FolderCatalog {
  const catalog: FolderCatalog = new Map();
  for (const manifest of manifests) {
    for (const folder of manifest.folders ?? []) {
      if (!catalog.has(folder.folder_id)) catalog.set(folder.folder_id, to_selectable(folder));
    }
  }
  return catalog;
}

/** Counts the distinct entry folders the catalog does not name. Entries without one are skipped. */
function count_unrecorded_folders(
  catalog: FolderCatalog,
  entries: readonly ManifestEntry[],
): number {
  const unrecorded = new Set<string>();
  for (const entry of entries) {
    if (entry.folder_id && !catalog.has(entry.folder_id)) unrecorded.add(entry.folder_id);
  }
  return unrecorded.size;
}

/**
 * Adds the live folders the catalog lacks, and a live role to a recorded folder that has none.
 * A recorded path is kept, so a folder moved or deleted since the backup keeps its original path.
 */
function add_live_folders(catalog: FolderCatalog, live: readonly MailFolder[]): void {
  for (const folder of live) {
    const recorded = catalog.get(folder.folder_id);
    if (!recorded) catalog.set(folder.folder_id, to_selectable(folder));
    else if (!recorded.well_known_name && folder.well_known_name) {
      catalog.set(folder.folder_id, { ...recorded, well_known_name: folder.well_known_name });
    }
  }
}

/**
 * Lists the source mailbox to name folders no manifest records. A mailbox Graph does not serve is
 * gone, unlicensed or, in a cross-tenant restore, in another tenant; the error then says why the
 * run needed it. Any other failure, such as throttling, is rethrown as it is.
 */
async function list_folders_for_unrecorded(
  source: SourceFolders,
  entries: readonly ManifestEntry[],
  unrecorded: number,
): Promise<MailFolder[]> {
  try {
    return await list_source_folders(source, entries);
  } catch (err) {
    if (!is_mailbox_unavailable(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new NotFoundError(
      `${unrecorded} folder(s) of the selected messages are not recorded in the backup's ` +
        'manifests, which predate recorded folders, and the source mailbox could not be listed ' +
        `to name them (${reason}). This happens when the mailbox was deleted or unlicensed, or ` +
        'when restoring into another tenant. Backups taken with Atlas 5.2.3 or later record ' +
        'their folders and restore without the source mailbox.',
      { cause: err },
    );
  }
}

/** Lists the source mailbox for a selector the recorded folders do not match; empty on failure. */
async function list_folders_for_unmatched(
  source: SourceFolders,
  entries: readonly ManifestEntry[],
  selector: string,
): Promise<MailFolder[]> {
  try {
    return await list_source_folders(source, entries);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      `Folder "${selector}" matches no folder the backup recorded, and the source mailbox ` +
        `could not be listed to look further: ${reason}`,
    );
    return [];
  }
}

/** Lists the source mailbox, reaching Recoverable Items only when an entry came from there. */
async function list_source_folders(
  source: SourceFolders,
  entries: readonly ManifestEntry[],
): Promise<MailFolder[]> {
  const listing = folder_listing_for(entries);
  return listing
    ? source.connector.list_mail_folders(source.tenant_id, source.owner_id, listing)
    : source.connector.list_mail_folders(source.tenant_id, source.owner_id);
}

/** True when Graph does not serve the mailbox: a 404, or the error an adapter translated it into. */
function is_mailbox_unavailable(err: unknown): boolean {
  if (err instanceof NotFoundError || err instanceof MailboxNotLicensedError) return true;
  return typeof err === 'object' && err !== null && Reflect.get(err, 'statusCode') === 404;
}

/** Keeps the fields a folder selector reads. */
function to_selectable(folder: SelectableFolder): SelectableFolder {
  return {
    folder_id: folder.folder_id,
    folder_path: folder.folder_path,
    ...(folder.well_known_name ? { well_known_name: folder.well_known_name } : {}),
  };
}
