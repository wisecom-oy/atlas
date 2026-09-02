import { inject, injectable } from 'inversify';
import type {
  FileSaveOptions,
  FileSaveResult,
  SharePointManifestRepository,
  SharePointSaveUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { save_drive_snapshot } from '@wisecom/atlas-drive/save/save-snapshot';
import { sharepoint_manifest_lookup } from '@/services/shared/manifest-lookup';

@injectable()
export class SharePointSaveService implements SharePointSaveUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
  ) {}

  /** Saves files from a SharePoint snapshot to a local zip archive. */
  async save_snapshot(
    tenant_id: string,
    site_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult> {
    return save_drive_snapshot(
      {
        workload: 'sharepoint',
        tenant_factory: this._tenant_factory,
        manifests: sharepoint_manifest_lookup(this._manifests),
      },
      tenant_id,
      site_id,
      options,
    );
  }
}
