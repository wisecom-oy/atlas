import type { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import type {
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
  OneDriveVersionRestoreUseCase,
  SharePointVersionRestoreUseCase,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_VERSION_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_VERSION_RESTORE_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import {
  resolve_owner,
  resolve_tenant_id,
  type OneDriveTenantOptions,
} from '@/commands/onedrive-command.handlers';
import {
  resolve_site_id,
  resolve_tenant_id as resolve_sharepoint_tenant_id,
  type SharePointTenantOptions,
} from '@/commands/sharepoint-command.handlers';
import { format_bytes } from '@/command-formatters';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

/** Flags shared by both drives; only the scope flag differs. */
interface VersionRestoreFlags {
  file?: string;
  version?: string;
  before?: string;
  path?: string;
  inPlace?: boolean;
}

export interface OneDriveRestoreVersionOptions extends OneDriveTenantOptions, VersionRestoreFlags {
  owner: string;
}

export interface SharePointRestoreVersionOptions
  extends SharePointTenantOptions, VersionRestoreFlags {
  site: string;
}

interface RestoredRow {
  path: string;
  version: string;
  modified: string;
  size: string;
}

const restored_columns: TableColumn<RestoredRow>[] = [
  { key: 'path', header: 'Restored to' },
  { key: 'version', header: 'Version' },
  { key: 'modified', header: 'Modified' },
  { key: 'size', header: 'Size', align: 'right' },
];

/** Turns CLI flags into service options, rejecting combinations that cannot mean anything. */
export function build_version_restore_options(
  flags: VersionRestoreFlags,
): DriveVersionRestoreOptions {
  if (flags.version !== undefined && flags.file === undefined) {
    throw new Error('--version needs --file: a version id is only unique within one file');
  }
  if (flags.file === undefined && flags.before === undefined) {
    throw new Error('Pass --file with --version, or --before for a bulk rollback');
  }
  if (flags.path !== undefined && flags.file !== undefined) {
    throw new Error('--path scopes a bulk rollback and cannot be combined with --file');
  }

  let before: Date | undefined;
  if (flags.before !== undefined) {
    before = new Date(flags.before);
    if (Number.isNaN(before.getTime())) {
      throw new Error(`--before is not a valid date: '${flags.before}'`);
    }
  }

  return {
    ...(flags.file !== undefined ? { file_ref: flags.file } : {}),
    ...(flags.version !== undefined ? { version_id: flags.version } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(flags.path !== undefined ? { path_prefix: flags.path } : {}),
    placement: flags.inPlace === true ? 'in-place' : 'copy',
  };
}

/** Runs `atlas onedrive restore-version`. */
export async function execute_onedrive_restore_version(
  container: Container,
  options: OneDriveRestoreVersionOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const use_case = container.get<OneDriveVersionRestoreUseCase>(
    ONEDRIVE_VERSION_RESTORE_USE_CASE_TOKEN,
  );
  const result = await use_case.restore_onedrive_version(
    tenant_id,
    owner.object_id,
    build_version_restore_options(options),
  );
  await report_version_restore('Atlas OneDrive Version Restore', result);
}

/** Runs `atlas sharepoint restore-version`. */
export async function execute_sharepoint_restore_version(
  container: Container,
  options: SharePointRestoreVersionOptions,
): Promise<void> {
  const tenant_id = resolve_sharepoint_tenant_id(container, options);
  const site_id = await resolve_site_id(container, tenant_id, options.site);
  const use_case = container.get<SharePointVersionRestoreUseCase>(
    SHAREPOINT_VERSION_RESTORE_USE_CASE_TOKEN,
  );
  const result = await use_case.restore_sharepoint_version(
    tenant_id,
    site_id,
    build_version_restore_options(options),
  );
  await report_version_restore('Atlas SharePoint Version Restore', result);
}

/** Prints what was written, then what was not, then the placement guarantee. */
async function report_version_restore(
  title: string,
  result: DriveVersionRestoreResult,
): Promise<void> {
  await render_static_view(<Banner title={title} />);

  if (result.restored.length > 0) {
    const rows: RestoredRow[] = result.restored.map((item) => ({
      path: item.restored_to,
      version: item.version_id ?? '(current)',
      modified: item.last_modified_at ?? '-',
      size: format_bytes(item.size_bytes),
    }));
    await render_static_view(<DataTable columns={restored_columns} rows={rows} />);
  }

  // Skips are the load-bearing output of a rollback: a file with no pre-cutoff
  // version was not rolled back, and a silent run would read as complete.
  for (const failure of result.errors) logger.warn(failure);

  if (result.files_restored === 0) {
    logger.warn(`Nothing restored. ${result.files_skipped} file(s) skipped.`);
  } else {
    logger.success(
      `Restored ${result.files_restored} version(s), skipped ${result.files_skipped}.`,
    );
  }

  logger.info(
    result.placement === 'in-place'
      ? 'Uploaded over the original path. The previous content is kept as an earlier version by Microsoft 365.'
      : 'Written alongside the originals as "(restored ...)" copies. No live file was modified.',
  );

  if (result.interrupted) logger.warn('Run was interrupted before every version was restored.');
}
