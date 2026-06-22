import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type { SharePointCatalogUseCase, SharePointSiteConnector } from '@wisecom/atlas-types';
import {
  SHAREPOINT_CATALOG_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
} from '@wisecom/atlas-types';

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

async function execute_sharepoint_list_snapshots(
  container: Container,
  options: SharePointListSnapshotsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  const catalog = container.get<SharePointCatalogUseCase>(SHAREPOINT_CATALOG_USE_CASE_TOKEN);
  const snapshots = await catalog.list_sharepoint_snapshots(tenant_id, site.site_id);

  logger.banner('Atlas SharePoint Snapshots');
  if (snapshots.length === 0) {
    logger.info('No SharePoint snapshots found.');
    return;
  }
  for (const snap of snapshots) {
    logger.info(`${snap.snapshot_id}  ${snap.created_at.toISOString()}  files=${snap.total_files}`);
  }
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

  logger.banner('Atlas SharePoint File Versions');
  if (versions.length === 0) {
    logger.info('No versions found for this file.');
    return;
  }
  for (const ver of versions) {
    logger.info(
      `${ver.backup_at}  ${ver.snapshot_id}  ${ver.change_type}  ${ver.parent_path}/${ver.file_name}`,
    );
  }
}
