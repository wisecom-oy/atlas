import { createHash } from 'node:crypto';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  ensure_dek_on_target,
  ensure_replica_marker,
} from '@/services/replication/replica-target-bootstrap';
import { copy_objects_to_target } from '@/services/replication/replication-object-copy';

/** The only part of a drive manifest the copy path reads. */
export interface DriveObjectManifest {
  readonly entries: ReadonlyArray<{ readonly storage_key?: string | undefined }>;
}

export interface DriveReplicationTally {
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
  readonly source_manifest_checksum: string;
  readonly replicated_manifest_checksum: string;
}

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
  await ensure_dek_on_target(source_ctx, target_ctx);
  if (!options.skip_marker) {
    await ensure_replica_marker(target_ctx, source_ctx.tenant_id);
  }

  const storage_keys = collect_drive_storage_keys(manifest);
  const all_keys = [...storage_keys, ...(options.ancillary_keys ?? [])];
  // Drive results carry counts only, so the per-object list is dropped here.
  const { object_results: _per_object, ...tally } = await copy_objects_to_target(
    source_ctx,
    target_ctx,
    all_keys,
  );

  // A manifest is what makes a snapshot reachable, so a partial copy must leave none behind.
  // The chain copier decides "already replicated" from manifest presence alone, so writing one
  // after a failed blob copy makes the failure sticky: the next run skips the snapshot and never
  // retries the missing objects. Mirrors the Outlook gate in replicate_snapshot_to_target.
  if (tally.objects_failed > 0) {
    return { ...tally, source_manifest_checksum: '', replicated_manifest_checksum: '' };
  }

  const source_manifest_blob = await source_ctx.storage.get(manifest_key);
  const source_manifest_checksum = sha256_hex(source_manifest_blob);
  await target_ctx.storage.put(manifest_key, source_manifest_blob);
  const target_manifest_blob = await target_ctx.storage.get(manifest_key);
  const replicated_manifest_checksum = sha256_hex(target_manifest_blob);

  return {
    ...tally,
    source_manifest_checksum,
    replicated_manifest_checksum,
  };
}

function sha256_hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
