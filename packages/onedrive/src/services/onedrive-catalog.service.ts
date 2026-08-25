import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  OneDriveCatalogUseCase,
  OneDriveFileVersionIndex,
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

/** Maps a CLI file reference (Graph item id or rooted path) to a file id, if known. */
function resolve_file_id(
  indexes: OneDriveFileVersionIndex[],
  file_ref: string,
): string | undefined {
  const trimmed = file_ref.trim();
  if (!looks_like_path(trimmed)) {
    if (indexes.some((idx) => idx.file_id === trimmed)) return trimmed;
    return match_by_file_name(indexes, trimmed);
  }
  const want = normalize_path_ref(trimmed);
  for (const idx of indexes) {
    for (const v of idx.versions) {
      if (normalize_path_ref(version_logical_path(v)) === want) return idx.file_id;
    }
  }
  return undefined;
}

/**
 * Matches a bare filename against every indexed version of the owner's files.
 * Throws with the candidate paths when the name maps to more than one file.
 */
function match_by_file_name(
  indexes: OneDriveFileVersionIndex[],
  file_name: string,
): string | undefined {
  const matches = new Map<string, string>();
  for (const idx of indexes) {
    for (const v of idx.versions) {
      if (v.file_name === file_name) matches.set(idx.file_id, version_logical_path(v));
    }
  }
  if (matches.size > 1) {
    const candidates = [...new Set(matches.values())].sort().join(', ');
    throw new Error(
      `'${file_name}' matches ${matches.size} files: ${candidates}. Pass a full path instead.`,
    );
  }
  return [...matches.keys()][0];
}

/** Paths contain a slash; Graph ids do not. */
function looks_like_path(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\');
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
