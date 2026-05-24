import type { Container } from 'inversify';
import type {
  OneDriveApi,
  OneDriveBackupUseCase,
  OneDriveVerificationUseCase,
  OneDriveCatalogUseCase,
  OneDriveRestoreUseCase,
  OneDriveSaveUseCase,
} from '@atlas/types';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
} from '@atlas/types';

/** Builds the OneDriveApi sub-namespace from the DI container. */
export function create_onedrive_api(tenant_id: string, container: Container): OneDriveApi {
  const backup = container.get<OneDriveBackupUseCase>(ONEDRIVE_BACKUP_USE_CASE_TOKEN);
  const verification = container.get<OneDriveVerificationUseCase>(
    ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  );
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const restore = container.get<OneDriveRestoreUseCase>(ONEDRIVE_RESTORE_USE_CASE_TOKEN);
  const save = container.get<OneDriveSaveUseCase>(ONEDRIVE_SAVE_USE_CASE_TOKEN);

  return {
    async backup(owner_id, options) {
      return await backup.backup_onedrive(tenant_id, owner_id, options);
    },
    async verify(owner_id, snapshot_id) {
      return await verification.verify_onedrive_snapshot(tenant_id, owner_id, snapshot_id);
    },
    async restore(owner_id, options) {
      return await restore.restore_onedrive(tenant_id, owner_id, options);
    },
    async save(owner_id, options) {
      return await save.save_snapshot(tenant_id, owner_id, options);
    },
    async listSnapshots(owner_id) {
      return await catalog.list_onedrive_snapshots(tenant_id, owner_id);
    },
    async listFileVersions(owner_id, file_ref) {
      return await catalog.list_onedrive_file_versions(tenant_id, owner_id, file_ref);
    },
  };
}
