import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  DriveFileSystemInfo,
  DriveRestoredVersion,
  DriveVersionPlacement,
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import type {
  DriveFileVersionIndexView,
  DriveFileVersionRecord,
  DriveWorkload,
} from '@/drive-ports';
import { select_versions_to_restore, type SelectedVersion } from '@/versioning/version-selection';
import { build_restored_file_name, split_parent_path } from '@/versioning/version-placement';

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

/** The upload surface of a drive connector; both provider connectors satisfy it structurally. */
export interface DriveUploadConnector {
  upload_small_file(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<void>;
  upload_large_file(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_id: string,
    file_name: string,
    content: Buffer,
    conflict_behavior?: string,
    file_system_info?: DriveFileSystemInfo,
  ): Promise<void>;
}

/** What a provider supplies to the shared version restore flow. */
export interface DriveVersionRestoreDeps {
  readonly workload: DriveWorkload;
  readonly tenant_factory: TenantContextFactory;
  readonly connector: DriveUploadConnector;
  readonly list_indexes: (
    ctx: TenantContext,
    owner_id: string,
  ) => Promise<readonly DriveFileVersionIndexView[]>;
  /** Reads a stored version blob, verifying it, or returns undefined when it cannot be trusted. */
  readonly download_blob: (
    ctx: TenantContext,
    version: DriveFileVersionRecord,
  ) => Promise<Buffer | undefined>;
  /** Resolves or creates the folder chain the restored file goes into, within one drive. */
  readonly ensure_folder_path: (
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    parent_path: string,
    folder_ids: Map<string, string>,
  ) => Promise<string | undefined>;
}

/**
 * Pushes stored version bytes back into a live drive.
 *
 * Uploads the bytes Atlas holds rather than calling Graph's `restoreVersion`. `restoreVersion`
 * promotes a version the *service* still has, so it cannot help once version history is trimmed
 * or the file is gone, and its result cannot be checked against the manifest checksum. Uploading
 * a verified copy is the only path that guarantees the operator gets what the backup recorded.
 */
export async function restore_drive_version(
  deps: DriveVersionRestoreDeps,
  tenant_id: string,
  owner_id: string,
  options: DriveVersionRestoreOptions,
): Promise<DriveVersionRestoreResult> {
  const { workload } = deps;
  owner_id = normalize_owner_id(owner_id);
  const placement: DriveVersionPlacement = options.placement ?? 'copy';

  if (begin_operation_progress(options, 'restore', workload)) {
    finish_operation_progress(options, 'restore', workload, 0, 0);
    return {
      files_restored: 0,
      files_skipped: 0,
      restored: [],
      errors: [],
      interrupted: true,
      placement,
    };
  }

  const ctx = await deps.tenant_factory.create(tenant_id);
  try {
    const indexes = await deps.list_indexes(ctx, owner_id);
    const selection = select_versions_to_restore(indexes, options);

    // The version row records the drive it came from, so a version restore needs no drive lookup
    // and stays correct for an owning segment with several drives, where "the first drive" would
    // be a guess. One memo for all of them: `ensure_folder_path` keys it by `drive_id:path`, so
    // two drives holding the same path cannot collide in it (issue #316).
    const folder_ids = new Map<string, string>();
    const restored: DriveRestoredVersion[] = [];
    const errors: string[] = [...selection.skipped];
    let files_skipped = selection.skipped.length;

    emit_operation_progress(options, {
      operation: 'restore',
      workload,
      phase: 'processing',
      processed: 0,
      total: selection.selected.length,
    });

    for (const [index, candidate] of selection.selected.entries()) {
      if (options.should_interrupt?.() === true) break;
      const outcome = await restore_one_version(
        deps,
        tenant_id,
        owner_id,
        ctx,
        folder_ids,
        candidate,
        placement,
      );
      if (outcome.restored) restored.push(outcome.restored);
      else {
        files_skipped++;
        if (outcome.error) errors.push(outcome.error);
      }
      emit_operation_progress(options, {
        operation: 'restore',
        workload,
        phase: 'processing',
        processed: index + 1,
        total: selection.selected.length,
        current: candidate.version.file_name,
      });
    }

    const interrupted = finish_operation_progress(
      options,
      'restore',
      workload,
      restored.length + files_skipped,
      selection.selected.length + selection.skipped.length,
      // Against the same total reported above: `files_skipped` starts at the pre-skipped count,
      // so comparing it with `selected.length` alone under-reports an early stop.
      restored.length + files_skipped < selection.selected.length + selection.skipped.length,
    );

    return {
      files_restored: restored.length,
      files_skipped,
      restored,
      errors,
      interrupted,
      placement,
    };
  } finally {
    ctx.destroy();
  }
}

/** Fetches one stored version and uploads it, honouring the placement choice. */
async function restore_one_version(
  deps: DriveVersionRestoreDeps,
  tenant_id: string,
  owner_id: string,
  ctx: TenantContext,
  folder_ids: Map<string, string>,
  candidate: SelectedVersion,
  placement: DriveVersionPlacement,
): Promise<{ restored?: DriveRestoredVersion; error?: string }> {
  const { version, original_path } = candidate;
  const drive_id = version.drive_id;
  try {
    const content = await deps.download_blob(ctx, version);
    if (!content) {
      return { error: `${original_path}: stored version could not be read or verified` };
    }

    const { parent_path } = split_parent_path(original_path);
    const parent_id = await deps.ensure_folder_path(
      tenant_id,
      owner_id,
      drive_id,
      parent_path,
      folder_ids,
    );
    if (!parent_id) {
      return { error: `${original_path}: could not resolve or create ${parent_path}` };
    }

    const file_name = build_restored_file_name(version, placement);
    // 'replace' on the original path becomes a new service version and leaves the old current one
    // in history; 'fail' guarantees a sibling copy never silently overwrites something already
    // there.
    const conflict = placement === 'in-place' ? 'replace' : 'fail';
    // Issue #242: without this the service stamps the restore time, and the rolled-back file
    // looks like it was authored during the incident.
    const file_system_info = version.last_modified_at
      ? { last_modified_at: version.last_modified_at }
      : undefined;
    const args = [
      tenant_id,
      owner_id,
      drive_id,
      parent_id,
      file_name,
      content,
      conflict,
      file_system_info,
    ] as const;
    if (content.length <= SMALL_FILE_LIMIT) {
      await deps.connector.upload_small_file(...args);
    } else {
      await deps.connector.upload_large_file(...args);
    }

    const restored_to = parent_path === '/' ? `/${file_name}` : `${parent_path}/${file_name}`;
    logger.info(
      `Restored version ${version.version_id ?? '(current-state row)'} to ${restored_to}`,
    );
    return {
      restored: {
        file_id: candidate.file_id,
        version_id: version.version_id,
        last_modified_at: version.last_modified_at,
        size_bytes: version.size_bytes,
        restored_to,
      },
    };
  } catch (err) {
    const msg = `${original_path}: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(`Skipped ${msg}`);
    return { error: msg };
  }
}
