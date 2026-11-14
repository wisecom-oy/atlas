import type { TenantContext } from '@wisecom/atlas-types';
import {
  replicate_snapshot_objects,
  type SnapshotObjectsTally,
} from '@/services/replication/snapshot-objects-replicator';

/** The only part of a drive manifest the copy path reads. */
export interface DriveObjectManifest {
  readonly entries: ReadonlyArray<{ readonly storage_key?: string | undefined }>;
}

export type DriveReplicationTally = SnapshotObjectsTally;

/**
 * Every drive manifest entry that still has content, deleted entries carry no storage key.
 *
 * OneDrive and SharePoint manifests differ in their owning segment, never in their entries, so
 * this and everything below it work off the entry shape rather than a provider type.
 */
export function collect_drive_storage_keys(manifest: DriveObjectManifest): string[] {
  const keys: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.storage_key) keys.push(entry.storage_key);
  }
  return keys;
}

export interface DriveReplicateOptions {
  readonly skip_marker?: boolean;
  /** Additional S3 keys to copy alongside manifest entries (e.g. version indexes, delta cursors). */
  readonly ancillary_keys?: string[];
}

/**
 * Replicates a single drive snapshot from source to target.
 * Copies: DEK -> replica marker -> data blobs -> ancillary objects (indexes, cursors) -> manifest (always last).
 */
export async function replicate_drive_snapshot_objects(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: DriveObjectManifest,
  manifest_key: string,
  options: DriveReplicateOptions = {},
): Promise<DriveReplicationTally> {
  const object_keys = [...collect_drive_storage_keys(manifest), ...(options.ancillary_keys ?? [])];
  return replicate_snapshot_objects(source_ctx, target_ctx, object_keys, manifest_key, {
    ...(options.skip_marker !== undefined ? { skip_marker: options.skip_marker } : {}),
  });
}
