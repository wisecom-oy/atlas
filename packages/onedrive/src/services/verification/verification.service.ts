import { inject, injectable } from 'inversify';
import type {
  OneDriveFileVersionIndexRepository,
  OneDriveManifestRepository,
  OneDriveVerificationResult,
  OneDriveVerificationUseCase,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { verify_drive_snapshot } from '@wisecom/atlas-drive/verification/verify-snapshot';
import { onedrive_manifest_lookup } from '@/services/shared/manifest-lookup';

/** Verifies OneDrive snapshot blobs against manifest checksums and index consistency. */
@injectable()
export class OneDriveVerificationService implements OneDriveVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
  ) {}

  /** Loads the manifest and checks content blobs plus per-file index rows for the snapshot. */
  async verify_onedrive_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<OneDriveVerificationResult> {
    return verify_drive_snapshot(
      {
        workload: 'onedrive',
        tenant_factory: this._tenant_factory,
        manifests: onedrive_manifest_lookup(this._manifests),
        list_indexes: (ctx, manifest) => this._indexes.list_by_owner(ctx, manifest.owner_id),
      },
      tenant_id,
      owner_id,
      snapshot_id,
      options,
    );
  }
}
