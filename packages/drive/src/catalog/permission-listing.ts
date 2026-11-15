import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import type {
  DriveItemPermissions,
  DrivePermissionListing,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import {
  load_drive_chain_entries,
  type DriveChainEntryRow,
  type DriveChainManifest,
  type DriveManifestLookup,
} from '@/shared/manifest-chain';
import { join_drive_path } from '@/shared/logical-path';
import { entry_kind } from '@/shared/entry-kind';

/** What the permission listing reads. */
export interface DrivePermissionCatalogDeps<TManifest extends DriveChainManifest> {
  readonly tenant_factory: TenantContextFactory;
  readonly manifests: DriveManifestLookup<TManifest>;
}

/**
 * Lists who had access to what at a snapshot: every live item whose newest entry in the snapshot's
 * folded chain carries non-inherited permissions, sorted by path. The newest snapshot is used when
 * none is named. Answered from the backup alone; no Graph call is made.
 *
 * @throws NotFoundError when the owning segment has no snapshot, or not the one named.
 */
export async function list_drive_permissions<TManifest extends DriveChainManifest>(
  deps: DrivePermissionCatalogDeps<TManifest>,
  tenant_id: string,
  owner_id: string,
  snapshot_id?: string,
): Promise<DrivePermissionListing> {
  const ctx = await deps.tenant_factory.create_readonly(tenant_id);
  try {
    const owner = normalize_owner_id(owner_id);
    const target = snapshot_id ?? (await newest_snapshot_id(deps.manifests, ctx, owner));
    const chain = await load_drive_chain_entries(deps.manifests, ctx, owner, target);
    return { snapshot_id: target, items: items_with_permissions(chain.entries) };
  } finally {
    ctx.destroy();
  }
}

async function newest_snapshot_id<TManifest>(
  manifests: DriveManifestLookup<TManifest>,
  ctx: TenantContext,
  owner_id: string,
): Promise<string> {
  const { summaries } = await manifests.list_snapshot_summaries(ctx, owner_id);
  const newest = [...summaries].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  if (!newest) throw new NotFoundError(`No ${manifests.workload} snapshot found for ${owner_id}`);
  return newest.snapshot_id;
}

function items_with_permissions(rows: readonly DriveChainEntryRow[]): DriveItemPermissions[] {
  return rows
    .map(({ entry }) => entry)
    .filter((entry) => entry.change_type !== 'deleted' && (entry.permissions?.length ?? 0) > 0)
    .map((entry) => ({
      file_id: entry.file_id,
      drive_id: entry.drive_id,
      path: join_drive_path(entry.parent_path, entry.file_name),
      kind: entry_kind(entry),
      permissions: entry.permissions ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
