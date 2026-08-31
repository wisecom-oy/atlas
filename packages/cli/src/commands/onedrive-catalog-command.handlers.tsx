import { format_bytes } from '@/command-formatters';
import type { Container } from 'inversify';
import { logger } from '@wisecom/atlas-core';
import type { OneDriveCatalogUseCase } from '@wisecom/atlas-types';
import { ONEDRIVE_CATALOG_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import {
  resolve_owner,
  resolve_tenant_id,
  type OneDriveTenantOptions,
} from '@/commands/onedrive-command.handlers';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

export interface OneDriveListSnapshotsOptions extends OneDriveTenantOptions {
  owner: string;
}

export interface OneDriveListVersionsOptions extends OneDriveTenantOptions {
  owner: string;
  file: string;
}

interface SnapshotRow {
  snapshot_id: string;
  created_at: string;
  total_files: number;
}

const snapshot_columns: TableColumn<SnapshotRow>[] = [
  { key: 'snapshot_id', header: 'Snapshot' },
  { key: 'created_at', header: 'Created' },
  { key: 'total_files', header: 'Files', align: 'right' },
];

interface FileVersionRow {
  version: string;
  modified: string;
  size: string;
  backup_at: string;
  snapshot_id: string;
  change_type: string;
  path: string;
}

const file_version_columns: TableColumn<FileVersionRow>[] = [
  // Version and Modified come first: they are what `restore-version` consumes,
  // and a listing that omits the id cannot be acted on.
  { key: 'version', header: 'Version' },
  { key: 'modified', header: 'Modified' },
  { key: 'size', header: 'Size' },
  { key: 'backup_at', header: 'Backed up' },
  { key: 'snapshot_id', header: 'Snapshot' },
  { key: 'change_type', header: 'Change' },
  { key: 'path', header: 'Path' },
];

export async function execute_onedrive_list_snapshots(
  container: Container,
  options: OneDriveListSnapshotsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const snapshots = await catalog.list_onedrive_snapshots(tenant_id, owner.object_id);

  await render_static_view(<Banner title="Atlas OneDrive Snapshots" />);
  if (snapshots.length === 0) {
    logger.info('No OneDrive snapshots found.');
    return;
  }
  const rows: SnapshotRow[] = snapshots.map((snap) => ({
    snapshot_id: snap.snapshot_id,
    created_at: snap.created_at.toISOString(),
    total_files: snap.total_files,
  }));
  await render_static_view(<DataTable columns={snapshot_columns} rows={rows} />);
}

export async function execute_onedrive_list_versions(
  container: Container,
  options: OneDriveListVersionsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const versions = await catalog.list_onedrive_file_versions(
    tenant_id,
    owner.object_id,
    options.file,
  );

  await render_static_view(<Banner title="Atlas OneDrive File Versions" />);
  if (versions.length === 0) {
    logger.info('No versions found for this file.');
    return;
  }
  const rows: FileVersionRow[] = versions.map((ver) => ({
    version: ver.version_id ?? '(current)',
    modified: ver.last_modified_at ?? '-',
    size: format_bytes(ver.size_bytes),
    backup_at: ver.backup_at,
    snapshot_id: ver.snapshot_id,
    change_type: ver.change_type,
    path: `${ver.parent_path}/${ver.file_name}`,
  }));
  await render_static_view(<DataTable columns={file_version_columns} rows={rows} />);
}
