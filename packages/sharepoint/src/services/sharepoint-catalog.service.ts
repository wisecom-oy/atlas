import { resolve_file_id } from '@/services/sharepoint-version-reference';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
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
    site_id = normalize_owner_id(site_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await this._manifests.list_snapshots_by_site(ctx, site_id);
    } finally {
      ctx.destroy();
    }
  }

  /** Resolves `file_ref` to a Graph file id (or path) and returns stored version rows. */
  async list_sharepoint_file_versions(
    tenant_id: string,
    site_id: string,
    file_ref: string,
  ): Promise<SharePointFileVersionRecord[]> {
    site_id = normalize_owner_id(site_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      // One index scan serves both the reference lookup and the listing: the
      // index is spread over per-run objects, so a per-file lookup would
      // rescan the whole site prefix (issue #161).
      const indexes = await this._indexes.list_by_site(ctx, site_id);
      const file_id = resolve_file_id(indexes, file_ref);
      if (!file_id) return [];
      return indexes.find((idx) => idx.file_id === file_id)?.versions ?? [];
    } finally {
      ctx.destroy();
    }
  }
}
