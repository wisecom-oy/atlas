import { inject, injectable } from 'inversify';
import type {
  OneDriveFileVersionIndexRepository,
  OneDriveManifestRepository,
  OwnerLeasePort,
  QuarantineResult,
  QuarantineUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { quarantine_unreadable_object } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import { drive_quarantine_target } from '@wisecom/atlas-drive/shared/drive-quarantine-target';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

/** Moves an unreadable OneDrive manifest or version index aside (issue #631). */
@injectable()
export class OneDriveQuarantineService implements QuarantineUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /** Moves the object at `storage_key` to `_quarantine/`, refusing one that reads cleanly. */
  async quarantine_unreadable_object(
    tenant_id: string,
    storage_key: string,
  ): Promise<QuarantineResult> {
    const target = drive_quarantine_target(
      'OneDrive',
      'onedrive',
      ONEDRIVE_KEYS,
      {
        read_manifest: (ctx, key) => this._manifests.read_manifest_at(ctx, key),
        read_index_object: (ctx, key) => this._indexes.read_index_object_at(ctx, key),
      },
      (ctx, owner_id, snapshot_id) =>
        this._manifests.forget_snapshot_summary(ctx, owner_id, snapshot_id),
    );
    return quarantine_unreadable_object(
      this._tenant_factory,
      this._leases,
      target,
      tenant_id,
      storage_key,
    );
  }
}
