import { inject, injectable } from 'inversify';
import type {
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
  OneDriveConnector,
  OneDriveFileVersionIndexRepository,
  OneDriveVersionRestoreUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { restore_drive_version } from '@wisecom/atlas-drive/restore/version-restore';
import { download_and_decrypt_blob } from '@/services/restore/blob-restore';
import { ensure_onedrive_folder_path } from '@/services/restore/restore-folder-path';

/** Pushes stored OneDrive version bytes back into a live drive. */
@injectable()
export class OneDriveVersionRestoreService implements OneDriveVersionRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
  ) {}

  /** Restores one stored version, or every file's last version before a cutoff. */
  async restore_onedrive_version(
    tenant_id: string,
    owner_id: string,
    options: DriveVersionRestoreOptions,
  ): Promise<DriveVersionRestoreResult> {
    return restore_drive_version(
      {
        workload: 'onedrive',
        tenant_factory: this._tenant_factory,
        connector: this._connector,
        list_indexes: (ctx, id) => this._indexes.list_by_owner(ctx, id),
        download_blob: download_and_decrypt_blob,
        ensure_folder_path: (tenant, id, drive_id, parent_path, folder_ids) =>
          ensure_onedrive_folder_path(
            this._connector,
            tenant,
            id,
            drive_id,
            parent_path,
            folder_ids,
          ),
      },
      tenant_id,
      owner_id,
      options,
    );
  }
}
