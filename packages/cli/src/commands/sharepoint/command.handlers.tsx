import type { Container } from 'inversify';
import { Box } from 'ink';
import { report_unreadable_keys } from '@/command-unreadable-objects';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type {
  SharePointBackupResult,
  SharePointSiteTreeBackupUseCase,
  SharePointRestoreUseCase,
  SharePointSaveUseCase,
  SharePointSiteConnector,
  SharePointVerificationUseCase,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { build_object_lock_request } from '@/command-object-lock';
import {
  report_backup_verdict,
  report_run_outcome,
  report_skipped_items,
} from '@/command-run-outcome';
import { run_interruptible } from '@/adapters/interruptible-run';
import {
  DRIVE_RESTORE_INTERRUPT_MESSAGE,
  report_drive_restore,
} from '@/commands/drive/restore-presenter';
import { resolve_site_id } from '@/commands/sharepoint/site-resolution';
import {
  require_target_for_profile,
  resolve_restore_container,
  target_profile_items,
} from '@/commands/shared/restore-target-container';

export interface SharePointTenantOptions {
  tenant?: string;
}

export interface SharePointBackupOptions extends SharePointTenantOptions {
  site: string;
  full?: boolean;
  includeSubsites?: boolean;
  retentionDays?: string;
  lockMode?: string;
}

export interface SharePointVerifyOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
}

export interface SharePointRestoreCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  targetSite?: string;
  targetProfile?: string;
  fileFilter?: string[];
  conflict?: 'replace' | 'rename' | 'fail';
  destination?: string;
  inPlace?: boolean;
  name?: string;
}

export interface SharePointSaveCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  fileFilter?: string[];
  output?: string;
  skipVerify?: boolean;
}

const BACKUP_INTERRUPT_MESSAGE =
  'Stopping the current transfer; the delta cursor is not advanced for an interrupted run';

/** Resolves the tenant id from CLI options, falling back to the configured tenant. */
export function resolve_tenant_id(container: Container, options: SharePointTenantOptions): string {
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

  await render_static_view(<Banner title={banner_title('sharepoint', 'Sites')} />);
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
  // Built before the Graph lookup: invalid Object Lock flags must fail without a network call.
  const object_lock_request = build_object_lock_request(options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const backup = container.get<SharePointSiteTreeBackupUseCase>(
    SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  );
  const results = await run_interruptible(container, BACKUP_INTERRUPT_MESSAGE, (gate) =>
    backup.backup_site_tree(tenant_id, site.site_id, {
      force_full: options.full ?? false,
      include_subsites: options.includeSubsites ?? false,
      site_url: site.site_url,
      site_display_name: site.display_name,
      object_lock_request,
      should_interrupt: gate.should_interrupt,
      abort_signal: gate.abort_signal,
    }),
  );
  if (results === undefined) return;

  await render_static_view(<Banner title={banner_title('sharepoint', 'Backup')} />);
  if (results.length > 1) {
    logger.info(`Backed up ${results.length} site(s) including subsites`);
  }

  for (const result of results) {
    await report_site_backup(result);
  }

  // Per-site reporting already listed the errors and set the partial-run exit
  // code, and named each site's damaged manifests with exit 9; all that is left is the verdict
  // over the whole site tree.
  report_backup_verdict(
    results.every((r) => r.summary.healthy),
    results.some((r) => (r.summary.unreadable_keys?.length ?? 0) > 0),
  );
}

/** Renders the per-site section of a backup run. */
async function report_site_backup(result: SharePointBackupResult): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
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
  } else if (result.summary.no_snapshot_reason === 'no_content') {
    // "No changes" on a site that holds nothing reads as backed up, and there is no recovery
    // point at all (issue #405).
    logger.warn('No SharePoint content found. Nothing was backed up and no snapshot exists.');
  } else if (result.summary.no_snapshot_reason === 'no_changes') {
    logger.info('No SharePoint changes detected. Snapshot skipped.');
  } else {
    // No reason means the run was interrupted or unhealthy, so its changes did not land (#683).
    logger.warn('No snapshot created: the run was interrupted or every change failed.');
  }

  const { versions_stored, versions_unavailable } = result.summary;
  if (versions_stored > 0 || versions_unavailable > 0) {
    logger.info(
      `Versions: ${versions_stored} stored, ${versions_unavailable} unavailable (expired)`,
    );
  }

  // Warnings, errors, and the partial-run exit code go through the shared
  // reporter so every site's failures are attributed to that site. The overall
  // HEALTHY/UNHEALTHY verdict is the caller's, once every site has reported.
  report_run_outcome(
    {
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      interrupted: result.interrupted,
    },
    'file',
  );
  report_unreadable_keys(result.summary.unreadable_keys);
}

export async function execute_sharepoint_restore(
  container: Container,
  options: SharePointRestoreCommandOptions,
): Promise<void> {
  require_target_for_profile(options.targetProfile, options.targetSite, '--target-site');
  const restore_container = resolve_restore_container(container, options.targetProfile);
  const tenant_id = resolve_tenant_id(container, options);
  // The source names stored backups, so a site id needs no Graph call; only the target is live.
  const site_id = await resolve_site_id(container, tenant_id, options.site);

  let target_site_id: string | undefined;
  if (options.targetSite) {
    const connector = restore_container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
    const target = await connector.resolve_site(tenant_id, options.targetSite);
    logger.info(`Target site: ${target.display_name} (${target.site_id})`);
    target_site_id = target.site_id;
  }

  const restore = restore_container.get<SharePointRestoreUseCase>(
    SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  );
  const result = await run_interruptible(
    restore_container,
    DRIVE_RESTORE_INTERRUPT_MESSAGE,
    (gate) =>
      restore.restore_sharepoint(tenant_id, site_id, {
        snapshot_id: options.snapshot,
        ...(target_site_id ? { target_site_id } : {}),
        ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
        ...(options.conflict ? { conflict_behavior: options.conflict } : {}),
        ...(options.destination ? { destination: options.destination } : {}),
        ...(options.inPlace === true ? { in_place: true } : {}),
        ...(options.name ? { rename_to: options.name } : {}),
        should_interrupt: gate.should_interrupt,
        abort_signal: gate.abort_signal,
      }),
  );
  if (result === undefined) return;

  await report_drive_restore(
    banner_title('sharepoint', 'Restore'),
    result,
    target_profile_items(options.targetProfile, restore_container),
  );
}

export async function execute_sharepoint_save(
  container: Container,
  options: SharePointSaveCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const site_id = await resolve_site_id(container, tenant_id, options.site);

  const save_uc = container.get<SharePointSaveUseCase>(SHAREPOINT_SAVE_USE_CASE_TOKEN);
  const result = await save_uc.save_snapshot(tenant_id, site_id, {
    snapshot_id: options.snapshot,
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.output ? { output_path: options.output } : {}),
    ...(options.skipVerify ? { skip_integrity_check: true } : {}),
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('sharepoint', 'Save')} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files saved', value: String(result.files_saved) },
        ]}
      />
    </Box>,
  );
  report_skipped_items(result.files_skipped, 'File');
  report_unreadable_keys(result.unreadable_keys);
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
  const site_id = await resolve_site_id(container, tenant_id, options.site);

  const verifier = container.get<SharePointVerificationUseCase>(
    SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  );
  const result = await verifier.verify_sharepoint_snapshot(tenant_id, site_id, options.snapshot);

  await render_static_view(<Banner title={banner_title('sharepoint', 'Verify')} />);
  report_unreadable_keys(result.unreadable_keys);
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
