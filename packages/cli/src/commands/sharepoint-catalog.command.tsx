import { format_bytes } from '@/command-formatters';
import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type { SharePointCatalogUseCase, SharePointSiteConnector } from '@wisecom/atlas-types';
import {
  SHAREPOINT_CATALOG_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
} from '@wisecom/atlas-types';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';

type ContainerFactory = () => Container;

interface SharePointTenantOptions {
  tenant?: string;
}

interface SharePointListSnapshotsOptions extends SharePointTenantOptions {
  site: string;
}

interface SharePointListVersionsOptions extends SharePointTenantOptions {
  site: string;
  file: string;
}

/** Registers `atlas sharepoint list-snapshots` subcommand. */
export function register_sharepoint_list_snapshots(
  group: Command,
  get_container: ContainerFactory,
): void {
  group
    .command('list-snapshots')
    .description('List SharePoint snapshots for a site')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointListSnapshotsOptions) =>
      execute_sharepoint_list_snapshots(get_container(), options),
    );
}

/** Registers `atlas sharepoint list-versions` subcommand. */
export function register_sharepoint_list_versions(
  group: Command,
  get_container: ContainerFactory,
): void {
  group
    .command('list-versions')
    .description('List all backed-up versions for a specific file')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .requiredOption('-f, --file <ref>', 'file ID or path')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointListVersionsOptions) =>
      execute_sharepoint_list_versions(get_container(), options),
    );
}

function resolve_tenant_id(container: Container, options: SharePointTenantOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
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

async function execute_sharepoint_list_snapshots(
  container: Container,
  options: SharePointListSnapshotsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  const catalog = container.get<SharePointCatalogUseCase>(SHAREPOINT_CATALOG_USE_CASE_TOKEN);
  const snapshots = await catalog.list_sharepoint_snapshots(tenant_id, site.site_id);

  await render_static_view(<Banner title="Atlas SharePoint Snapshots" />);
  if (snapshots.length === 0) {
    logger.info('No SharePoint snapshots found.');
    return;
  }
  const rows: SnapshotRow[] = snapshots.map((snap) => ({
    snapshot_id: snap.snapshot_id,
    created_at: snap.created_at.toISOString(),
    total_files: snap.total_files,
  }));
  await render_static_view(<DataTable columns={snapshot_columns} rows={rows} />);
}

async function execute_sharepoint_list_versions(
  container: Container,
  options: SharePointListVersionsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  const catalog = container.get<SharePointCatalogUseCase>(SHAREPOINT_CATALOG_USE_CASE_TOKEN);
  const versions = await catalog.list_sharepoint_file_versions(
    tenant_id,
    site.site_id,
    options.file,
  );

  await render_static_view(<Banner title="Atlas SharePoint File Versions" />);
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
