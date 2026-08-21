import type {
  OneDriveReplicationUseCase,
  ReplicationResult,
  SharePointReplicationUseCase,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { OD_MANIFEST_PREFIX } from '@/services/replication/onedrive-replication-helpers';
import { SP_MANIFEST_PREFIX } from '@/services/replication/sharepoint-replication-helpers';

/**
 * Snapshot ids are self-describing: `od-snap-*` for OneDrive, `sp-snap-*` for SharePoint,
 * `snap-*` for Outlook. The workload comes from the id; only the owning segment has to be
 * looked up, because the drive replication use cases are addressed by owner or site.
 */
const OD_SNAPSHOT_PREFIX = 'od-snap-';
const SP_SNAPSHOT_PREFIX = 'sp-snap-';

interface DriveSnapshotLocation {
  readonly workload: 'onedrive' | 'sharepoint';
  /** Owner id for OneDrive, site id for SharePoint: the segment under the manifest root. */
  readonly owner_segment: string;
}

/** True when the id belongs to a drive workload rather than Outlook. */
export function is_drive_snapshot_id(snapshot_id: string): boolean {
  return snapshot_id.startsWith(OD_SNAPSHOT_PREFIX) || snapshot_id.startsWith(SP_SNAPSHOT_PREFIX);
}

/**
 * Resolves the owner or site that holds a drive snapshot by scanning its workload's manifest
 * root, so `-s <id>` works without the operator also naming the owner. Undefined when the id
 * is not a drive id, or when no manifest for it exists in the given context.
 */
export async function locate_drive_snapshot(
  ctx: TenantContext,
  snapshot_id: string,
): Promise<DriveSnapshotLocation | undefined> {
  const workload = snapshot_id.startsWith(OD_SNAPSHOT_PREFIX)
    ? 'onedrive'
    : snapshot_id.startsWith(SP_SNAPSHOT_PREFIX)
      ? 'sharepoint'
      : undefined;
  if (workload === undefined) return undefined;

  const root = workload === 'onedrive' ? OD_MANIFEST_PREFIX : SP_MANIFEST_PREFIX;
  const keys = await ctx.storage.list(`${root}/`);
  const match = keys.find((key) => key.endsWith(`/${snapshot_id}.json`));
  if (match === undefined) return undefined;

  // `<root>/<owner-or-site>/<snapshot-id>.json`: the segment before the file name.
  const segments = match.split('/');
  const owner_segment = segments[segments.length - 2];
  if (owner_segment === undefined || owner_segment.length === 0) return undefined;
  return { workload, owner_segment };
}

interface DriveReplicationDeps {
  readonly onedrive: OneDriveReplicationUseCase;
  readonly sharepoint: SharePointReplicationUseCase;
}

/**
 * Replicates a drive snapshot through its own workload service. Undefined when the id is not a
 * drive snapshot, which tells the caller to keep going with the Outlook path.
 */
export async function replicate_drive_snapshot(
  ctx: TenantContext,
  tenant_id: string,
  snapshot_id: string,
  targets: StorageTarget[],
  deps: DriveReplicationDeps,
): Promise<ReplicationResult[] | undefined> {
  const location = await locate_drive_snapshot(ctx, snapshot_id);
  if (location === undefined) return undefined;

  if (location.workload === 'onedrive') {
    return await deps.onedrive.replicate_owner(
      tenant_id,
      location.owner_segment,
      snapshot_id,
      targets,
    );
  }
  return await deps.sharepoint.replicate_site(
    tenant_id,
    location.owner_segment,
    snapshot_id,
    targets,
  );
}

/**
 * Recovers a drive snapshot from a replica through its own workload service. The location is
 * resolved against the source, because the snapshot is by definition missing from primary.
 */
export async function rehydrate_drive_snapshot(
  source_ctx: TenantContext,
  tenant_id: string,
  snapshot_id: string,
  source: StorageTarget,
  deps: DriveReplicationDeps,
): Promise<ReplicationResult | undefined> {
  const location = await locate_drive_snapshot(source_ctx, snapshot_id);
  if (location === undefined) return undefined;

  if (location.workload === 'onedrive') {
    return await deps.onedrive.rehydrate_owner_snapshot(
      tenant_id,
      location.owner_segment,
      snapshot_id,
      source,
    );
  }
  return await deps.sharepoint.rehydrate_site_snapshot(
    tenant_id,
    location.owner_segment,
    snapshot_id,
    source,
  );
}
