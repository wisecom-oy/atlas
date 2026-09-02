import { inject, injectable } from 'inversify';
import type {
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
  SharePointFileVersionIndexRepository,
  SharePointSiteConnector,
  SharePointVersionRestoreUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { restore_drive_version } from '@wisecom/atlas-drive/restore/version-restore';
import { download_and_decrypt } from '@/services/restore/restore-content';
import { ensure_sharepoint_folder_path } from '@/services/restore/restore-folder-path';

/** Pushes stored SharePoint version bytes back into a live drive. */
@injectable()
export class SharePointVersionRestoreService implements SharePointVersionRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: SharePointFileVersionIndexRepository,
  ) {}

  /** Restores one stored version, or every file's last version before a cutoff. */
  async restore_sharepoint_version(
    tenant_id: string,
    site_id: string,
    options: DriveVersionRestoreOptions,
  ): Promise<DriveVersionRestoreResult> {
    return restore_drive_version(
      {
        workload: 'sharepoint',
        tenant_factory: this._tenant_factory,
        connector: this._connector,
        list_indexes: (ctx, id) => this._indexes.list_by_site(ctx, id),
        download_blob: download_and_decrypt,
        ensure_folder_path: (tenant, id, drive_id, parent_path, folder_ids) =>
          ensure_sharepoint_folder_path(
            this._connector,
            tenant,
            id,
            drive_id,
            parent_path,
            folder_ids,
          ),
      },
      tenant_id,
      site_id,
      options,
    );
  }
}
