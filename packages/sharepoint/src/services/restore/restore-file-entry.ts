import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { restore_parent_path } from '@wisecom/atlas-core/services/shared/restore-destination';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  LargeFileContent,
  SharePointManifestEntry,
  SharePointSiteConnector,
  TenantContext,
} from '@wisecom/atlas-types';
import { read_restore_content } from '@wisecom/atlas-drive/restore/restore-content-read';
import {
  apply_restored_file_permissions,
  type ItemSharingRestoreDeps,
} from '@wisecom/atlas-drive/restore/item-sharing-restore';
import { ensure_sharepoint_folder_path } from '@/services/restore/restore-folder-path';

/** Where one file is restored. */
export interface FileRestoreTarget {
  readonly tenant_id: string;
  readonly target_site: string;
  readonly drive_id: string;
  readonly conflict: string;
  readonly folder_ids: Map<string, string>;
  readonly root: string;
  readonly file_name: string;
}

/**
 * Restores one file entry, reporting whether it landed or was skipped, then reapplies its
 * permissions when the operator asked for them. A permission that cannot be reapplied is reported
 * on the run's sharing summary and never fails the file.
 */
export async function restore_sharepoint_file_entry(
  connector: SharePointSiteConnector,
  ctx: TenantContext,
  entry: SharePointManifestEntry,
  target: FileRestoreTarget,
  errors: string[],
  sharing: ItemSharingRestoreDeps,
): Promise<'restored' | 'skipped' | 'cancelled'> {
  const target_path = restore_parent_path(target.root, entry.parent_path);
  try {
    const parent_id = await ensure_sharepoint_folder_path(
      connector,
      target.tenant_id,
      target.target_site,
      target.drive_id,
      target_path,
      target.folder_ids,
    );

    if (parent_id === undefined) {
      errors.push(`Could not create folder path: ${target_path} in drive ${target.drive_id}`);
      return 'skipped';
    }

    // A damaged object fails only its own file, and the run goes on (issue #712). Recording the
    // reason is what makes the run exit partial instead of reporting success.
    const read = await read_restore_content(ctx, entry);
    if (read.kind === 'unrestorable') {
      errors.push(`${entry.file_name}: ${read.reason}; skipped`);
      return 'skipped';
    }
    const item_id = await upload_content(connector, entry, target, parent_id, read.content);
    logger.info(`Restored: ${target_path}/${target.file_name} (drive: ${target.drive_id})`);
    await apply_restored_file_permissions(sharing, target.drive_id, item_id, entry);
    return 'restored';
  } catch (err) {
    // An upload cut short by Ctrl+C is the run stopping, not a failed file (issue #682), unless its
    // final chunk was sent and may have created the file, which is named either way (issue #892).
    const may_exist = err instanceof UploadCommitUnknownError;
    if (is_active_run_cancelled() && !may_exist) return 'cancelled';
    const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    logger.warn(`Skipped ${entry.file_name}: ${msg}`);
    return is_active_run_cancelled() ? 'cancelled' : 'skipped';
  }
}

/**
 * Uploads the content in the shape the blob reader returned: a buffer below the small-file limit,
 * a stream above it. Resolves the created item's id when Graph returned one.
 */
async function upload_content(
  connector: SharePointSiteConnector,
  entry: SharePointManifestEntry,
  target: FileRestoreTarget,
  parent_id: string,
  content: LargeFileContent,
): Promise<string | undefined> {
  if (Buffer.isBuffer(content)) {
    return connector.upload_small_file(
      target.tenant_id,
      target.target_site,
      target.drive_id,
      parent_id,
      target.file_name,
      content,
      target.conflict,
      entry.file_system_info,
    );
  }
  return connector.upload_large_file(
    target.tenant_id,
    target.target_site,
    target.drive_id,
    parent_id,
    target.file_name,
    content,
    target.conflict,
    entry.file_system_info,
  );
}
