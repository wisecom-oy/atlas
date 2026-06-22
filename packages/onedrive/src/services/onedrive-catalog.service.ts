import { inject, injectable } from 'inversify';
import type {
  OneDriveCatalogUseCase,
  OneDriveFileVersionIndexRepository,
  OneDriveFileVersionRecord,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
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
    const ctx = await this._tenant_factory.create(tenant_id);
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
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const file_id = await this.resolve_file_id(ctx, owner_id, file_ref);
      if (!file_id) return [];
      const index = await this._indexes.find_by_file_id(ctx, owner_id, file_id);
      return index?.versions ?? [];
    } finally {
      ctx.destroy();
    }
  }

  /** Maps a CLI file reference (Graph item id or rooted path) to a file id, if known. */
  private async resolve_file_id(
    ctx: TenantContext,
    owner_id: string,
    file_ref: string,
  ): Promise<string | undefined> {
    const trimmed = file_ref.trim();
    if (!this.looks_like_path(trimmed)) {
      const direct = await this._indexes.find_by_file_id(ctx, owner_id, trimmed);
      return direct ? trimmed : undefined;
    }
    const want = normalize_path_ref(trimmed);
    const indexes = await this._indexes.list_by_owner(ctx, owner_id);
    for (const idx of indexes) {
      for (const v of idx.versions) {
        if (normalize_path_ref(version_logical_path(v)) === want) return idx.file_id;
      }
    }
    return undefined;
  }

  /** Paths contain a slash; Graph ids do not. */
  private looks_like_path(ref: string): boolean {
    return ref.includes('/') || ref.includes('\\');
  }
}

/** NFC-normalized path string comparable to stored manifest/index paths. */
function normalize_path_ref(raw: string): string {
  const unified = raw.replace(/\\/g, '/').trim();
  const with_slash = unified.startsWith('/') ? unified : `/${unified}`;
  return with_slash.normalize('NFC');
}

function version_logical_path(v: OneDriveFileVersionRecord): string {
  const base = v.parent_path.replace(/\/+$/, '') || '';
  if (base === '' || base === '/') return `/${v.file_name}`;
  return `${base}/${v.file_name}`;
}
