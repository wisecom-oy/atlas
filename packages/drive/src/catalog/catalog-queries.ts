import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { return_or_raise_partial } from '@wisecom/atlas-core/services/shared/unreadable-object-report';
import type {
  ReadableManifestListing,
  ReadableVersionIndexListing,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { resolve_file_id } from '@/versioning/version-reference';

/** The two read-only repositories a drive catalog serves listings from. */
export interface DriveCatalogDeps<TManifest> {
  readonly tenant_factory: TenantContextFactory;
  readonly list_snapshots: (
    ctx: TenantContext,
    owner_id: string,
  ) => Promise<ReadableManifestListing<TManifest>>;
  readonly list_indexes: (
    ctx: TenantContext,
    owner_id: string,
  ) => Promise<ReadableVersionIndexListing<DriveFileVersionIndexView>>;
}

/**
 * Returns snapshot manifests for the owning segment, newest first.
 *
 * @throws UnreadableObjectsError naming each damaged manifest, with the readable snapshots in
 *   `partial_result`, so one damaged manifest never hides the rest (issue #631).
 */
export async function list_drive_snapshots<TManifest>(
  deps: DriveCatalogDeps<TManifest>,
  tenant_id: string,
  owner_id: string,
): Promise<TManifest[]> {
  const ctx = await deps.tenant_factory.create_readonly(tenant_id);
  try {
    const listing = await deps.list_snapshots(ctx, normalize_owner_id(owner_id));
    return return_or_raise_partial(listing.unreadable_keys, listing.manifests);
  } finally {
    ctx.destroy();
  }
}

/**
 * Resolves `file_ref` to a Graph file id (or path) and returns the stored version rows.
 *
 * @throws UnreadableObjectsError naming each version index object that could not be read, with
 *   the rows that could in `partial_result`. A run's versions are otherwise silently absent, and
 *   a file's history looks shorter than what was backed up (issue #631).
 */
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
    const listing = await deps.list_indexes(ctx, normalize_owner_id(owner_id));
    const file_id = resolve_file_id(listing.indexes, file_ref);
    const versions = file_id
      ? (listing.indexes.find((idx) => idx.file_id === file_id)?.versions ?? [])
      : [];
    return return_or_raise_partial(listing.unreadable_keys, versions);
  } finally {
    ctx.destroy();
  }
}
