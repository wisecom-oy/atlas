import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { resolve_file_id } from '@/versioning/version-reference';

/** The two read-only repositories a drive catalog serves listings from. */
export interface DriveCatalogDeps<TManifest> {
  readonly tenant_factory: TenantContextFactory;
  readonly list_snapshots: (ctx: TenantContext, owner_id: string) => Promise<TManifest[]>;
  readonly list_indexes: (
    ctx: TenantContext,
    owner_id: string,
  ) => Promise<readonly DriveFileVersionIndexView[]>;
}

/** Returns snapshot manifests for the owning segment, newest first. */
export async function list_drive_snapshots<TManifest>(
  deps: DriveCatalogDeps<TManifest>,
  tenant_id: string,
  owner_id: string,
): Promise<TManifest[]> {
  const ctx = await deps.tenant_factory.create_readonly(tenant_id);
  try {
    return await deps.list_snapshots(ctx, normalize_owner_id(owner_id));
  } finally {
    ctx.destroy();
  }
}

/** Resolves `file_ref` to a Graph file id (or path) and returns the stored version rows. */
export async function list_drive_file_versions<TManifest>(
  deps: DriveCatalogDeps<TManifest>,
  tenant_id: string,
  owner_id: string,
  file_ref: string,
): Promise<readonly DriveFileVersionRecord[]> {
  const ctx = await deps.tenant_factory.create_readonly(tenant_id);
  try {
    // One index scan serves both the reference lookup and the listing: the index is spread over
    // per-run objects, so a per-file lookup would rescan the whole owner prefix (issue #161).
    const indexes = await deps.list_indexes(ctx, normalize_owner_id(owner_id));
    const file_id = resolve_file_id(indexes, file_ref);
    if (!file_id) return [];
    return indexes.find((idx) => idx.file_id === file_id)?.versions ?? [];
  } finally {
    ctx.destroy();
  }
}
