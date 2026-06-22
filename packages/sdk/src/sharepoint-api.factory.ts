import type { Container } from 'inversify';
import type {
  SharePointApi,
  SharePointBackupUseCase,
  SharePointCatalogUseCase,
  SharePointReplicationUseCase,
  SharePointRestoreUseCase,
  SharePointSaveUseCase,
  SharePointVerificationUseCase,
  SharePointDeletionUseCase,
  SharePointStatusUseCase,
  SharePointSiteConnector,
} from '@atlas/types';
import {
  SHAREPOINT_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CATALOG_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_STATUS_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
} from '@atlas/types';

/** Builds the SharePointApi sub-namespace from the DI container. */
export function create_sharepoint_api(tenant_id: string, container: Container): SharePointApi {
  const backup = container.get<SharePointBackupUseCase>(SHAREPOINT_BACKUP_USE_CASE_TOKEN);
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

  return {
    async backup(site_id, options) {
      return await backup.backup_site(tenant_id, site_id, options);
    },
    async verify(site_id, snapshot_id) {
      return await verification.verify_sharepoint_snapshot(tenant_id, site_id, snapshot_id);
    },
    async restore(site_id, options) {
      return await restore.restore_sharepoint(tenant_id, site_id, options);
    },
    async save(site_id, options) {
      return await save.save_snapshot(tenant_id, site_id, options);
    },
    async listSnapshots(site_id) {
      return await catalog.list_sharepoint_snapshots(tenant_id, site_id);
    },
    async listFileVersions(site_id, file_ref) {
      return await catalog.list_sharepoint_file_versions(tenant_id, site_id, file_ref);
    },
    async listSites() {
      return await connector.list_sites(tenant_id);
    },
    async resolveSite(url_or_id) {
      return await connector.resolve_site(tenant_id, url_or_id);
    },
    async deleteSiteData(site_id) {
      return await deletion.delete_site_data(tenant_id, site_id);
    },
    async deleteSnapshot(site_id, snapshot_id) {
      return await deletion.delete_snapshot(tenant_id, site_id, snapshot_id);
    },
    async replicateSnapshot(site_id, snapshot_id, targets) {
      return await replication.replicate_site(tenant_id, site_id, snapshot_id, targets);
    },
    async replicateAll(site_id, targets) {
      return await replication.replicate_all_site_snapshots(tenant_id, site_id, targets);
    },
    async rehydrateSnapshot(site_id, snapshot_id, source) {
      return await replication.rehydrate_site_snapshot(tenant_id, site_id, snapshot_id, source);
    },
    async rehydrateSite(site_id, source) {
      return await replication.rehydrate_site(tenant_id, site_id, source);
    },
    async checkStatus(site_id) {
      return await status.check_sharepoint_status(tenant_id, site_id);
    },
  };
}
