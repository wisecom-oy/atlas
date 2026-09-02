import { inject, injectable } from 'inversify';
import type {
  SharePointCatalogUseCase,
  SharePointFileVersionIndexRepository,
  SharePointFileVersionRecord,
  SharePointManifestRepository,
  SharePointSnapshotManifest,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  list_drive_file_versions,
  list_drive_snapshots,
  type DriveCatalogDeps,
} from '@wisecom/atlas-drive/catalog/catalog-queries';

/** Lists SharePoint snapshots and per-file version history from manifest and index repositories. */
@injectable()
export class SharePointCatalogService implements SharePointCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
    @inject(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: SharePointFileVersionIndexRepository,
  ) {}

  /** Returns snapshot manifests for the site, newest first. */
  async list_sharepoint_snapshots(
    tenant_id: string,
    site_id: string,
  ): Promise<SharePointSnapshotManifest[]> {
    return list_drive_snapshots(this.catalog_deps(), tenant_id, site_id);
  }

  /** Resolves `file_ref` to a Graph file id (or path) and returns stored version rows. */
  async list_sharepoint_file_versions(
    tenant_id: string,
    site_id: string,
    file_ref: string,
  ): Promise<SharePointFileVersionRecord[]> {
    const versions = await list_drive_file_versions(
      this.catalog_deps(),
      tenant_id,
      site_id,
      file_ref,
    );
    return [...versions];
  }

  private catalog_deps(): DriveCatalogDeps<SharePointSnapshotManifest> {
    return {
      tenant_factory: this._tenant_factory,
      list_snapshots: (ctx, site_id) => this._manifests.list_snapshots_by_site(ctx, site_id),
      list_indexes: (ctx, site_id) => this._indexes.list_by_site(ctx, site_id),
    };
  }
}
