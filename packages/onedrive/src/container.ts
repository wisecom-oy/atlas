import { type Container } from 'inversify';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { GraphOneDriveConnector } from '@/adapters/graph-onedrive-connector.adapter';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';
import { S3OneDriveDeltaCursorRepository } from '@/adapters/s3-onedrive-delta-cursor-repository.adapter';
import { S3OneDriveFileVersionIndexRepository } from '@/adapters/s3-onedrive-file-version-index-repository.adapter';
import { OneDriveBackupService } from '@/services/onedrive-backup.service';
import { OneDriveRestoreService } from '@/services/onedrive-restore.service';
import { OneDriveSaveService } from '@/services/onedrive-save.service';
import { OneDriveCatalogService } from '@/services/onedrive-catalog.service';
import { OneDriveVerificationService } from '@/services/onedrive-verification.service';

/** Registers OneDrive-specific DI bindings. Requires TENANT_CONTEXT_FACTORY_TOKEN to be bound first. */
export function bind_onedrive(container: Container): void {
  if (!container.isBound(TENANT_CONTEXT_FACTORY_TOKEN)) {
    throw new Error(
      'TENANT_CONTEXT_FACTORY_TOKEN must be bound before calling bind_onedrive. ' +
        'Call bind_s3_storage() first.',
    );
  }
  container.bind(ONEDRIVE_CONNECTOR_TOKEN).to(GraphOneDriveConnector).inSingletonScope();
  container
    .bind(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    .to(S3OneDriveManifestRepository)
    .inSingletonScope();
  container
    .bind(ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN)
    .to(S3OneDriveDeltaCursorRepository)
    .inSingletonScope();
  container
    .bind(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    .to(S3OneDriveFileVersionIndexRepository)
    .inSingletonScope();
  container.bind(ONEDRIVE_BACKUP_USE_CASE_TOKEN).to(OneDriveBackupService).inSingletonScope();
  container.bind(ONEDRIVE_CATALOG_USE_CASE_TOKEN).to(OneDriveCatalogService).inSingletonScope();
  container
    .bind(ONEDRIVE_VERIFICATION_USE_CASE_TOKEN)
    .to(OneDriveVerificationService)
    .inSingletonScope();
  container.bind(ONEDRIVE_RESTORE_USE_CASE_TOKEN).to(OneDriveRestoreService).inSingletonScope();
  container.bind(ONEDRIVE_SAVE_USE_CASE_TOKEN).to(OneDriveSaveService).inSingletonScope();
}
