import { randomUUID } from 'node:crypto';
import type { Snapshot } from '@atlas/types';
import { SnapshotStatus } from '@atlas/types';
import type { Manifest, ManifestEntry, ManifestObjectLockPolicy } from '@atlas/types';

export interface OwnerIdentityHint {
  readonly owner_email?: string | undefined;
  readonly owner_display_name?: string | undefined;
}

/** Creates a snapshot record in IN_PROGRESS state. */
export function create_pending_snapshot(
  tenant_id: string,
  owner_id: string,
  identity?: OwnerIdentityHint,
): Snapshot {
  return {
    id: randomUUID(),
    tenant_id,
    owner_id,
    ...(identity?.owner_email !== undefined && { owner_email: identity.owner_email }),
    ...(identity?.owner_display_name !== undefined && {
      owner_display_name: identity.owner_display_name,
    }),
    started_at: new Date(),
    object_count: 0,
    status: SnapshotStatus.IN_PROGRESS,
  };
}

/** Returns a copy of the snapshot marked as COMPLETED with final counts. */
export function mark_snapshot_completed(snapshot: Snapshot, object_count: number): Snapshot {
  return {
    ...snapshot,
    completed_at: new Date(),
    object_count,
    status: SnapshotStatus.COMPLETED,
  };
}

/**
 * Assembles a complete manifest. When the current sync found no new entries,
 * carries forward the prior backup's total_objects so the stale-delta
 * safeguard does not mistake an unchanged mailbox for a never-backed-up one.
 */
export function build_manifest(
  owner_id: string,
  snapshot_id: string,
  entries: ManifestEntry[],
  delta_links: Record<string, string>,
  previous_total_objects = 0,
  object_lock?: ManifestObjectLockPolicy,
): Manifest {
  const total_size_bytes = entries.reduce((sum, e) => {
    const att_size = e.attachments?.reduce((a, att) => a + att.size_bytes, 0) ?? 0;
    return sum + e.size_bytes + att_size;
  }, 0);
  return {
    id: randomUUID(),
    tenant_id: '',
    owner_id,
    snapshot_id,
    created_at: new Date(),
    total_objects: Math.max(entries.length, previous_total_objects),
    total_size_bytes,
    delta_links,
    ...(object_lock ? { object_lock } : {}),
    entries,
  };
}
