import { inject, injectable } from 'inversify';
import type {
  OneDriveCatalogUseCase,
  OneDriveFileVersionIndexRepository,
  OneDriveFileVersionRecord,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  list_drive_file_versions,
  list_drive_snapshots,
  type DriveCatalogDeps,
} from '@wisecom/atlas-drive/catalog/catalog-queries';

/** Lists OneDrive snapshots and per-file version history from manifest and index repositories. */
@injectable()
export class OneDriveCatalogService implements OneDriveCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
  ) {}

  /** Returns snapshot manifests for the owner, newest first. */
  async list_onedrive_snapshots(
    tenant_id: string,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]> {
    return list_drive_snapshots(this.catalog_deps(), tenant_id, owner_id);
  }

  /** Resolves `file_ref` to a Graph file id (or path) and returns stored version rows. */
  async list_onedrive_file_versions(
    tenant_id: string,
    owner_id: string,
    file_ref: string,
  ): Promise<OneDriveFileVersionRecord[]> {
    const versions = await list_drive_file_versions(
      this.catalog_deps(),
      tenant_id,
      owner_id,
      file_ref,
    );
    return [...versions];
  }

  private catalog_deps(): DriveCatalogDeps<OneDriveSnapshotManifest> {
    return {
      tenant_factory: this._tenant_factory,
      list_snapshots: (ctx, owner_id) => this._manifests.list_snapshots_by_owner(ctx, owner_id),
      list_indexes: (ctx, owner_id) => this._indexes.list_by_owner(ctx, owner_id),
    };
  }
}
