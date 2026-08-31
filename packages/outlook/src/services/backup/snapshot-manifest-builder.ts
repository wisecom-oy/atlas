import { randomUUID } from 'node:crypto';
import type { Snapshot } from '@wisecom/atlas-types';
import { SnapshotStatus } from '@wisecom/atlas-types';
import type {
  ExcludedFolder,
  MailboxPurpose,
  Manifest,
  ManifestEntry,
  ManifestObjectLockPolicy,
} from '@wisecom/atlas-types';
import type { BackupSyncMode } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

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

/** Optional manifest facts that not every run has. */
export interface ManifestBuildExtras {
  readonly previous_total_objects?: number | undefined;
  readonly object_lock?: ManifestObjectLockPolicy | undefined;
  readonly mailbox_purpose?: MailboxPurpose | undefined;
  /** Folders this run did not capture, with why. */
  readonly excluded_folders?: ExcludedFolder[] | undefined;
}

/**
 * Assembles a complete manifest. When the current sync found no new entries,
 * carries forward the prior backup's total_objects so the stale-delta
 * safeguard does not mistake an unchanged mailbox for a never-backed-up one.
 * mailbox_purpose (Graph userPurpose at backup time) is recorded when known.
 */
export function build_manifest(
  owner_id: string,
  snapshot_id: string,
  entries: ManifestEntry[],
  delta_links: Record<string, string>,
  extras: ManifestBuildExtras = {},
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
    total_objects: Math.max(entries.length, extras.previous_total_objects ?? 0),
    total_size_bytes,
    delta_links,
    id_format: 'immutable',
    ...(extras.object_lock ? { object_lock: extras.object_lock } : {}),
    ...(extras.mailbox_purpose ? { mailbox_purpose: extras.mailbox_purpose } : {}),
    ...(extras.excluded_folders && extras.excluded_folders.length > 0
      ? { excluded_folders: extras.excluded_folders }
      : {}),
    entries,
  };
}

/** Resolves whether a mailbox run is full, incremental, or its initial backup. */
export function resolve_sync_mode(
  force_full: boolean | undefined,
  saved_links: Record<string, string>,
): BackupSyncMode {
  if (force_full) return 'full';
  return Object.keys(saved_links).length > 0 ? 'incremental' : 'initial';
}

/**
 * Returns the previous manifest's delta links for an incremental sync.
 * Manifests captured before the ImmutableId switch carry mutable IDs in both
 * delta links and entries; resuming them would mix ID formats, so the first
 * backup after upgrade restarts full (issue #48).
 */
export function resolve_saved_delta_links(previous: Manifest | undefined): Record<string, string> {
  if (!previous) return {};
  if (previous.id_format !== 'immutable') {
    logger.info(
      'previous snapshot uses legacy mutable message IDs; restarting with a full sync (issue #48)',
    );
    return {};
  }
  return previous.delta_links;
}
