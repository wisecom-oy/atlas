import { inject, injectable } from 'inversify';
import type {
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
  SharePointVerificationResult,
  SharePointVerificationUseCase,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { verify_drive_snapshot } from '@wisecom/atlas-drive/verification/verify-snapshot';
import { sharepoint_manifest_lookup } from '@/services/shared/manifest-lookup';

/** Verifies SharePoint snapshot blobs against manifest checksums and index consistency. */
@injectable()
export class SharePointVerificationService implements SharePointVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
    @inject(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: SharePointFileVersionIndexRepository,
  ) {}

  /** Loads the manifest and checks content blobs plus per-file index rows for the snapshot. */
  async verify_sharepoint_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<SharePointVerificationResult> {
    return verify_drive_snapshot(
      {
        workload: 'sharepoint',
        tenant_factory: this._tenant_factory,
        manifests: sharepoint_manifest_lookup(this._manifests),
        list_indexes: (ctx, manifest) => this._indexes.list_by_site(ctx, manifest.site_id),
      },
      tenant_id,
      site_id,
      snapshot_id,
      options,
    );
  }
}
