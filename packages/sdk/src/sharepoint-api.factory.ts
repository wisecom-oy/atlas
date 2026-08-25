import type { Container } from 'inversify';
import type {
  SharePointApi,
  SharePointSiteTreeBackupUseCase,
  SharePointCatalogUseCase,
  SharePointReplicationUseCase,
  SharePointRestoreUseCase,
  SharePointSaveUseCase,
  SharePointVerificationUseCase,
  SharePointDeletionUseCase,
  SharePointStatusUseCase,
  SharePointSiteConnector,
  StatsUseCase,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CATALOG_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_STATUS_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  STATS_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { adapt_operation_options } from '@/operation-options';

/** Builds the SharePointApi sub-namespace from the DI container. */
export function create_sharepoint_api(tenant_id: string, container: Container): SharePointApi {
  const backup = container.get<SharePointSiteTreeBackupUseCase>(
    SHAREPOINT_SITE_TREE_BACKUP_USE_CASE_TOKEN,
  );
  const verification = container.get<SharePointVerificationUseCase>(
    SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  );
  const replication = container.get<SharePointReplicationUseCase>(
    SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  );
  const restore = container.get<SharePointRestoreUseCase>(SHAREPOINT_RESTORE_USE_CASE_TOKEN);
  const save = container.get<SharePointSaveUseCase>(SHAREPOINT_SAVE_USE_CASE_TOKEN);
  const catalog = container.get<SharePointCatalogUseCase>(SHAREPOINT_CATALOG_USE_CASE_TOKEN);
  const deletion = container.get<SharePointDeletionUseCase>(SHAREPOINT_DELETION_USE_CASE_TOKEN);
  const status = container.get<SharePointStatusUseCase>(SHAREPOINT_STATUS_USE_CASE_TOKEN);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);

  /**
   * Mirrors the CLI: a composite site ID contains commas, anything else is a URL or hostname
   * and gets resolved through Graph first. Passing a URL straight through addresses a
   * non-existent site and returns an empty result instead of failing.
   */
  async function resolve_site_id(site: string): Promise<string> {
    if (site.includes(',')) return site;
    return (await connector.resolve_site(tenant_id, site)).site_id;
  }

  return {
    async backup(site_input, options) {
      const site_id = await resolve_site_id(site_input);
      return await backup.backup_site_tree(tenant_id, site_id, adapt_operation_options(options));
    },
    async verify(site_input, snapshot_id, options) {
      const site_id = await resolve_site_id(site_input);
      const adapted = adapt_operation_options(options);
      return adapted === undefined
        ? await verification.verify_sharepoint_snapshot(tenant_id, site_id, snapshot_id)
        : await verification.verify_sharepoint_snapshot(tenant_id, site_id, snapshot_id, adapted);
    },
    async restore(site_input, options) {
      const site_id = await resolve_site_id(site_input);
      return await restore.restore_sharepoint(
        tenant_id,
        site_id,
        adapt_operation_options(options)!,
      );
    },
    async save(site_input, options) {
      const site_id = await resolve_site_id(site_input);
      return await save.save_snapshot(tenant_id, site_id, adapt_operation_options(options)!);
    },
    async listSnapshots(site_input) {
      return await catalog.list_sharepoint_snapshots(tenant_id, await resolve_site_id(site_input));
    },
    async listFileVersions(site_input, file_ref) {
      const site_id = await resolve_site_id(site_input);
      return await catalog.list_sharepoint_file_versions(tenant_id, site_id, file_ref);
    },
    async listSites() {
      return await connector.list_sites(tenant_id);
    },
    async resolveSite(url_or_id) {
      return await connector.resolve_site(tenant_id, url_or_id);
    },
    async deleteSiteData(site_input) {
      return await deletion.delete_site_data(tenant_id, await resolve_site_id(site_input));
    },
    async deleteSnapshot(site_input, snapshot_id) {
      const site_id = await resolve_site_id(site_input);
      return await deletion.delete_snapshot(tenant_id, site_id, snapshot_id);
    },
    async replicateSnapshot(site_input, snapshot_id, targets) {
      const site_id = await resolve_site_id(site_input);
      return await replication.replicate_site(tenant_id, site_id, snapshot_id, targets);
    },
    async replicateAll(site_input, targets) {
      const site_id = await resolve_site_id(site_input);
      return await replication.replicate_all_site_snapshots(tenant_id, site_id, targets);
    },
    async rehydrateSnapshot(site_input, snapshot_id, source) {
      const site_id = await resolve_site_id(site_input);
      return await replication.rehydrate_site_snapshot(tenant_id, site_id, snapshot_id, source);
    },
    async rehydrateSite(site_input, source) {
      const site_id = await resolve_site_id(site_input);
      return await replication.rehydrate_site(tenant_id, site_id, source);
    },
    async checkStatus(site_input) {
      return await status.check_sharepoint_status(tenant_id, await resolve_site_id(site_input));
    },
    async getStats(site_input) {
      const site_id = site_input === undefined ? undefined : await resolve_site_id(site_input);
      return await stats.get_sharepoint_stats(tenant_id, site_id);
    },
  };
}
