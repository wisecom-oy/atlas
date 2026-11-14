import { createHash } from 'node:crypto';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  ensure_dek_on_target,
  ensure_replica_marker,
} from '@/services/replication/replica-target-bootstrap';
import { copy_objects_to_target } from '@/services/replication/replication-object-copy';

/** Counts from copying one snapshot's objects, and the manifest checksums when it was written. */
export interface SnapshotObjectsTally {
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
  readonly source_manifest_checksum: string;
  readonly replicated_manifest_checksum: string;
}

export interface SnapshotObjectsReplicateOptions {
  /** True when copying back to the primary, which must not be labelled a replica of itself. */
  readonly skip_marker?: boolean;
}

/**
 * Copies one snapshot's objects to a destination, then its manifest.
 * Order: DEK, replica marker, every object in `object_keys`, manifest (always last).
 *
 * The manifest is what makes a snapshot reachable, and the chain copier decides "already copied"
 * from manifest presence alone. A manifest written after a failed object copy would make the
 * failure sticky, so when any object fails the manifest is not written and the next run retries.
 * Callers must validate that both buckets share the tenant's key before invoking.
 */
export async function replicate_snapshot_objects(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  object_keys: readonly string[],
  manifest_key: string,
  options: SnapshotObjectsReplicateOptions = {},
): Promise<SnapshotObjectsTally> {
  await ensure_dek_on_target(source_ctx, target_ctx);
  if (!options.skip_marker) {
    await ensure_replica_marker(target_ctx, source_ctx.tenant_id);
  }

  // Results carry counts only, so the per-object list is dropped here.
  const { object_results: _per_object, ...tally } = await copy_objects_to_target(
    source_ctx,
    target_ctx,
    object_keys,
  );
  if (tally.objects_failed > 0) {
    return { ...tally, source_manifest_checksum: '', replicated_manifest_checksum: '' };
  }

  const source_manifest_blob = await source_ctx.storage.get(manifest_key);
  await target_ctx.storage.put(manifest_key, source_manifest_blob);
  const target_manifest_blob = await target_ctx.storage.get(manifest_key);
  return {
    ...tally,
    source_manifest_checksum: sha256_hex(source_manifest_blob),
    replicated_manifest_checksum: sha256_hex(target_manifest_blob),
  };
}

function sha256_hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
