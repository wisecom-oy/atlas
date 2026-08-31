import { resolve_file_id } from '@/services/onedrive-version-reference';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
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
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return this._manifests.list_snapshots_by_owner(ctx, owner_id);
    } finally {
      ctx.destroy();
    }
  }

  /** Resolves `file_ref` to a Graph file id (or path) and returns stored version rows. */
  async list_onedrive_file_versions(
    tenant_id: string,
    owner_id: string,
    file_ref: string,
  ): Promise<OneDriveFileVersionRecord[]> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      // One index scan serves both the reference lookup and the listing: the
      // index is spread over per-run objects, so a per-file lookup would
      // rescan the whole owner prefix (issue #161).
      const indexes = await this._indexes.list_by_owner(ctx, owner_id);
      const file_id = resolve_file_id(indexes, file_ref);
      if (!file_id) return [];
      return indexes.find((idx) => idx.file_id === file_id)?.versions ?? [];
    } finally {
      ctx.destroy();
    }
  }
}
