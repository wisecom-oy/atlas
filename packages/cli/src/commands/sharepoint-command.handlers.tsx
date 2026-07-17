import type { Container } from 'inversify';
import { Box } from 'ink';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type {
  SharePointBackupUseCase,
  SharePointRestoreUseCase,
  SharePointSaveUseCase,
  SharePointSiteConnector,
  SharePointVerificationUseCase,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';

export interface SharePointTenantOptions {
  tenant?: string;
}

export interface SharePointBackupOptions extends SharePointTenantOptions {
  site: string;
  full?: boolean;
}

export interface SharePointVerifyOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
}

export interface SharePointRestoreCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  targetSite?: string;
  fileFilter?: string[];
  conflict?: 'replace' | 'rename' | 'fail';
}

export interface SharePointSaveCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  fileFilter?: string[];
  output?: string;
  skipVerify?: boolean;
}

function resolve_tenant_id(container: Container, options: SharePointTenantOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

interface SiteRow {
  site_id: string;
  display_name: string;
  site_url: string;
}

const site_columns: TableColumn<SiteRow>[] = [
  { key: 'site_id', header: 'Site ID' },
  { key: 'display_name', header: 'Name' },
  { key: 'site_url', header: 'URL' },
];

export async function execute_sharepoint_list_sites(
  container: Container,
  options: SharePointTenantOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const sites = await connector.list_sites(tenant_id);

  await render_static_view(<Banner title="Atlas SharePoint Sites" />);
  if (sites.length === 0) {
    logger.info('No SharePoint sites found.');
    return;
  }

  const rows: SiteRow[] = sites.map((site) => ({
    site_id: site.site_id,
    display_name: site.display_name,
    site_url: site.site_url,
  }));
  await render_static_view(<DataTable columns={site_columns} rows={rows} />);
  logger.info(`\n${sites.length} site(s) found.`);
}

export async function execute_sharepoint_backup(
  container: Container,
  options: SharePointBackupOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const backup = container.get<SharePointBackupUseCase>(SHAREPOINT_BACKUP_USE_CASE_TOKEN);
  const result = await backup.backup_site(tenant_id, site.site_id, {
    force_full: options.full ?? false,
    site_url: site.site_url,
    site_display_name: site.display_name,
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas SharePoint Backup" />
      <KeyValueList
        items={[
          { label: 'Site', value: result.site_id },
          { label: 'Libraries scanned', value: String(result.summary.libraries_scanned) },
        ]}
      />
    </Box>,
  );

  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    const counters: SummaryEntry[] = [
      { label: 'changed', value: result.summary.files_changed, color: 'cyan' },
      { label: 'stored', value: result.summary.files_stored, color: 'green' },
      { label: 'dedup', value: result.summary.files_deduplicated, color: 'yellow' },
    ];
    if (result.summary.deleted_items > 0) {
      counters.push({ label: 'deleted', value: result.summary.deleted_items, color: 'red' });
    }
    await render_static_view(<ResultSummary entries={counters} />);
  } else {
    logger.info('No SharePoint changes detected. Snapshot skipped.');
  }

  const { versions_stored, versions_unavailable } = result.summary;
  if (versions_stored > 0 || versions_unavailable > 0) {
    logger.info(
      `Versions: ${versions_stored} stored, ${versions_unavailable} unavailable (expired)`,
    );
  }

  for (const w of result.summary.warnings) {
    logger.warn(w);
  }

  if (result.summary.healthy) {
    logger.success('Status: HEALTHY');
  } else {
    logger.error('Status: UNHEALTHY');
    await render_static_view(
      <ErrorList errors={result.summary.errors} max={result.summary.errors.length} />,
    );
    process.exitCode = 1;
  }
}

export async function execute_sharepoint_restore(
  container: Container,
  options: SharePointRestoreCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  let target_site_id: string | undefined;
  if (options.targetSite) {
    const target = await connector.resolve_site(tenant_id, options.targetSite);
    logger.info(`Target site: ${target.display_name} (${target.site_id})`);
    target_site_id = target.site_id;
  }

  const restore = container.get<SharePointRestoreUseCase>(SHAREPOINT_RESTORE_USE_CASE_TOKEN);
  const result = await restore.restore_sharepoint(tenant_id, site.site_id, {
    snapshot_id: options.snapshot,
    ...(target_site_id ? { target_site_id } : {}),
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.conflict ? { conflict_behavior: options.conflict } : {}),
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas SharePoint Restore" />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files restored', value: String(result.files_restored) },
          { label: 'Folders created', value: String(result.folders_created) },
        ]}
      />
    </Box>,
  );
  if (result.files_skipped > 0) {
    logger.warn(`Files skipped: ${result.files_skipped}`);
  }
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    process.exitCode = 1;
  } else {
    logger.success('Restore completed successfully');
  }
}

export async function execute_sharepoint_save(
  container: Container,
  options: SharePointSaveCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const save_uc = container.get<SharePointSaveUseCase>(SHAREPOINT_SAVE_USE_CASE_TOKEN);
  const result = await save_uc.save_snapshot(tenant_id, site.site_id, {
    snapshot_id: options.snapshot,
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.output ? { output_path: options.output } : {}),
    ...(options.skipVerify ? { skip_integrity_check: true } : {}),
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas SharePoint Save" />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files saved', value: String(result.files_saved) },
        ]}
      />
    </Box>,
  );
  if (result.files_skipped > 0) logger.warn(`Files skipped: ${result.files_skipped}`);
  if (result.integrity_failures.length > 0)
    logger.warn(`Integrity failures: ${result.integrity_failures.length}`);
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    process.exitCode = 1;
  } else {
    const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
    logger.success(`Saved to ${result.output_path} (${size_mb} MB)`);
  }
}

export async function execute_sharepoint_verify(
  container: Container,
  options: SharePointVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const verifier = container.get<SharePointVerificationUseCase>(
    SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  );
  const result = await verifier.verify_sharepoint_snapshot(
    tenant_id,
    site.site_id,
    options.snapshot,
  );

  await render_static_view(<Banner title="Atlas SharePoint Verify" />);
  if (result.failed_file_ids.length === 0 && result.index_issues.length === 0) {
    logger.success(`All ${result.total_checked} entries passed verification`);
    return;
  }

  logger.error(
    `Failures: files=${result.failed_file_ids.length}, index=${result.index_issues.length}`,
  );
  const failures = [
    ...result.failed_file_ids.map((fid) => `blob mismatch: ${fid}`),
    ...result.index_issues.map((issue) => `index: ${issue}`),
  ];
  await render_static_view(<ErrorList errors={failures} max={failures.length} />);
  process.exitCode = 1;
}
