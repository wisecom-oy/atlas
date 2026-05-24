import { type Container } from 'inversify';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { GraphSharePointConnector } from '@/adapters/graph-sharepoint-connector.adapter';
import { S3SharePointManifestRepository } from '@/adapters/s3-sharepoint-manifest-repository.adapter';
import { S3SharePointDeltaCursorRepository } from '@/adapters/s3-sharepoint-delta-cursor-repository.adapter';
import { S3SharePointFileVersionIndexRepository } from '@/adapters/s3-sharepoint-file-version-index-repository.adapter';
import { SharePointBackupService } from '@/services/sharepoint-backup.service';
import { SharePointVerificationService } from '@/services/sharepoint-verification.service';
import { SharePointRestoreService } from '@/services/sharepoint-restore.service';
import { SharePointSaveService } from '@/services/sharepoint-save.service';

/** Registers SharePoint-specific DI bindings. Requires TENANT_CONTEXT_FACTORY_TOKEN to be bound first. */
export function bind_sharepoint(container: Container): void {
  if (!container.isBound(TENANT_CONTEXT_FACTORY_TOKEN)) {
    throw new Error(
      'TENANT_CONTEXT_FACTORY_TOKEN must be bound before calling bind_sharepoint. ' +
        'Call bind_s3_storage() first.',
    );
  }
  container.bind(SHAREPOINT_CONNECTOR_TOKEN).to(GraphSharePointConnector).inSingletonScope();
  container
    .bind(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    .to(S3SharePointManifestRepository)
    .inSingletonScope();
  container
    .bind(SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN)
    .to(S3SharePointDeltaCursorRepository)
    .inSingletonScope();
  container
    .bind(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    .to(S3SharePointFileVersionIndexRepository)
    .inSingletonScope();
  container.bind(SHAREPOINT_BACKUP_USE_CASE_TOKEN).to(SharePointBackupService).inSingletonScope();
  container
    .bind(SHAREPOINT_VERIFICATION_USE_CASE_TOKEN)
    .to(SharePointVerificationService)
    .inSingletonScope();
  container.bind(SHAREPOINT_RESTORE_USE_CASE_TOKEN).to(SharePointRestoreService).inSingletonScope();
  container.bind(SHAREPOINT_SAVE_USE_CASE_TOKEN).to(SharePointSaveService).inSingletonScope();
}
