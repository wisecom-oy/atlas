import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { restore_parent_path } from '@wisecom/atlas-core/services/shared/restore-destination';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  LargeFileContent,
  OneDriveConnector,
  OneDriveManifestEntry,
  OneDriveRestoreOptions,
  TenantContext,
} from '@wisecom/atlas-types';
import { read_restore_content } from '@wisecom/atlas-drive/restore/restore-content-read';
import {
  apply_restored_file_permissions,
  type ItemSharingRestoreDeps,
} from '@wisecom/atlas-drive/restore/item-sharing-restore';
import { rethrow_if_restore_run_refusal } from '@wisecom/atlas-drive/restore/restore-run-refusal';
import { ensure_onedrive_folder_path } from '@/services/restore/restore-folder-path';

/** Where one file is restored. */
export interface FileRestoreTarget {
  readonly tenant_id: string;
  readonly target_owner: string;
  readonly drive_id: string;
  readonly folder_ids: Map<string, string>;
  readonly conflict: NonNullable<OneDriveRestoreOptions['conflict_behavior']>;
  readonly root: string;
  readonly file_name: string;
}

/** How one file restore ended. */
export interface FileRestoreOutcome {
  readonly restored: boolean;
  readonly error?: string;
  readonly cancelled?: true;
}

/**
 * Restores one file entry to the target drive, then reapplies its permissions when the operator
 * asked for them. A permission that cannot be reapplied is reported on the run's sharing summary
 * and never fails the file. Throws a refusal of every restore write, such as a missing grant.
 */
export async function restore_onedrive_file_entry(
  connector: OneDriveConnector,
  ctx: TenantContext,
  entry: OneDriveManifestEntry,
  target: FileRestoreTarget,
  sharing: ItemSharingRestoreDeps,
): Promise<FileRestoreOutcome> {
  const target_path = restore_parent_path(target.root, entry.parent_path);
  try {
    const parent_id = await ensure_onedrive_folder_path(
      connector,
      target.tenant_id,
      target.target_owner,
      target.drive_id,
      target_path,
      target.folder_ids,
    );

    if (parent_id === undefined) {
      return { restored: false, error: `Could not create folder path: ${target_path}` };
    }

    // A damaged object fails only its own file, and the run goes on (issue #712). Recording the
    // reason is what makes the run exit partial instead of counting it as a quiet skip (#358).
    const read = await read_restore_content(ctx, entry);
    if (read.kind === 'unrestorable') {
      return { restored: false, error: `${entry.file_name}: ${read.reason}; skipped` };
    }
    const item_id = await upload_content(connector, entry, target, parent_id, read.content);
    logger.info(`Restored: ${target_path}/${target.file_name}`);
    await apply_restored_file_permissions(sharing, target.drive_id, item_id, entry);
    return { restored: true };
  } catch (err) {
    // An upload cut short by Ctrl+C is the run stopping, not a failed file (issue #682).
    if (is_active_run_cancelled()) return { restored: false, cancelled: true };
    // A refusal of every write would fail each remaining file the same way (issue #871).
    rethrow_if_restore_run_refusal('onedrive', err);
    const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(`Skipped ${entry.file_name}: ${msg}`);
    return { restored: false, error: msg };
  }
}

/**
 * Uploads the content in the shape the blob reader returned: a buffer below the small-file limit,
 * a stream above it. Resolves the created item's id when Graph returned one.
 */
async function upload_content(
  connector: OneDriveConnector,
  entry: OneDriveManifestEntry,
  target: FileRestoreTarget,
  parent_id: string,
  content: LargeFileContent,
): Promise<string | undefined> {
  if (Buffer.isBuffer(content)) {
    return connector.upload_small_file(
      target.tenant_id,
      target.target_owner,
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
    target.target_owner,
    target.drive_id,
    parent_id,
    target.file_name,
    content,
    target.conflict,
    entry.file_system_info,
  );
}
