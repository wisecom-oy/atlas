import { inject, injectable } from 'inversify';
import type {
  FileSaveOptions,
  FileSaveResult,
  OneDriveManifestRepository,
  OneDriveSaveUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { save_drive_snapshot } from '@wisecom/atlas-drive/save/save-snapshot';
import { onedrive_manifest_lookup } from '@/services/shared/manifest-lookup';

@injectable()
export class OneDriveSaveService implements OneDriveSaveUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
  ) {}

  /** Saves files from a OneDrive snapshot to a local zip archive. */
  async save_snapshot(
    tenant_id: string,
    owner_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult> {
    return save_drive_snapshot(
      {
        workload: 'onedrive',
        tenant_factory: this._tenant_factory,
        manifests: onedrive_manifest_lookup(this._manifests),
      },
      tenant_id,
      owner_id,
      options,
    );
  }
}
