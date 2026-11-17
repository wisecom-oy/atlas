/**
 * Where an Outlook restore puts the mail: a generated `Restore-{timestamp}` folder at the top of
 * the mailbox, or a folder path the caller chose (issue #684).
 *
 * A chosen destination is reused when it exists and created level by level when it does not,
 * matching the drive restores' "created if missing". It must not be a well-known folder such as
 * Inbox: restored mail would mix into live mail with no single folder to delete, the problem
 * #217 fixed for the drive restores by nesting under a restore root.
 */
import type { MailFolder, RestoreConnector } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { trim_slashes } from '@wisecom/atlas-core/services/shared/trim-slashes';
import { FOLDER_PATH_SEPARATOR } from '@/adapters/graph-folder-tree-enumerator';
import { create_restore_root } from '@/services/restore/folder-restore-planner';
import { FolderReusingRestoreConnector } from '@/services/restore/folder-reusing-restore-connector';

/**
 * The folder a restore nests the source tree under, and the connector it must write through.
 * `folder.display_name` is what the result reports as `restore_folder_name`: the generated name,
 * or the full destination path.
 */
export interface RestoreRoot {
  readonly folder: MailFolder;
  readonly connector: RestoreConnector;
}

/**
 * Splits a destination into folder names, or returns undefined when none was given. Leading and
 * trailing `/` are ignored. Throws, before any Graph call, for a path that names no folder or has
 * an empty level: Outlook has no in-place restore, so `/` cannot mean "the original folders".
 */
export function parse_restore_destination(destination: string | undefined): string[] | undefined {
  if (destination === undefined) return undefined;
  const trimmed = trim_slashes(destination.trim());
  if (trimmed.length === 0) {
    throw new Error(
      `Restore destination "${destination}" names no folder. Pass a folder path such as ` +
        '"Recovered/2026-03", or omit it to restore under a generated Restore-<timestamp> folder.',
    );
  }
  const segments = trimmed.split(FOLDER_PATH_SEPARATOR).map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Restore destination "${destination}" has an empty folder name between "/".`);
  }
  return segments;
}

/**
 * Opens the folder a restore writes under. Without a destination this creates the generated
 * root exactly as before and keeps the given connector; with one it resolves the path and returns
 * a connector that also reuses existing subfolders beneath it.
 */
export async function open_restore_root(
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  destination: string | undefined,
): Promise<RestoreRoot> {
  const segments = parse_restore_destination(destination);
  if (segments === undefined) {
    const folder = await create_restore_root(restore_connector, tenant_id, owner_id);
    return { folder, connector: restore_connector };
  }
  const reusing = new FolderReusingRestoreConnector(restore_connector);
  const folder = await resolve_destination_folder(reusing, tenant_id, owner_id, segments);
  return { folder, connector: reusing };
}

/**
 * Finds or creates each level of the destination path in turn. The top level is checked against
 * the well-known folders before anything is created beneath it.
 */
async function resolve_destination_folder(
  connector: FolderReusingRestoreConnector,
  tenant_id: string,
  owner_id: string,
  segments: readonly string[],
): Promise<MailFolder> {
  const path = segments.join(FOLDER_PATH_SEPARATOR);
  // Reported with the names the mailbox holds, which a case-insensitive match may differ from.
  const resolved_names: string[] = [];
  let parent_folder_id: string | undefined;
  let leaf: MailFolder | undefined;
  for (const [index, segment] of segments.entries()) {
    const resolved = await connector.find_or_create_mail_folder(
      tenant_id,
      owner_id,
      segment,
      parent_folder_id,
    );
    if (index === 0 && !resolved.created) {
      await assert_not_well_known(connector, tenant_id, owner_id, resolved.folder, path);
    }
    logger.info(
      `${resolved.created ? 'Created' : 'Reusing existing'} restore folder: ${resolved.folder.display_name}`,
    );
    resolved_names.push(resolved.folder.display_name);
    leaf = resolved.folder;
    parent_folder_id = leaf.folder_id;
  }
  const resolved_path = resolved_names.join(FOLDER_PATH_SEPARATOR);
  // parse_restore_destination never returns an empty list, so the loop ran at least once.
  return { ...leaf!, display_name: resolved_path, folder_path: resolved_path };
}

/** Refuses a destination whose top level is a well-known folder such as Inbox. */
async function assert_not_well_known(
  connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  top_level: MailFolder,
  path: string,
): Promise<void> {
  const role = await connector.find_well_known_folder_role(
    tenant_id,
    owner_id,
    top_level.folder_id,
  );
  if (role === undefined) return;
  throw new Error(
    `Restore destination "${path}" is inside the well-known folder "${top_level.display_name}" ` +
      `(${role}). Restored mail would mix with live mail there; choose a folder outside Inbox, ` +
      'Sent Items, Deleted Items and the other system folders.',
  );
}
