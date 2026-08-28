import type {
  OneDriveSnapshotManifest,
  ReplicationResult,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';
import { OD_MANIFEST_PREFIX } from '@/services/replication/onedrive-replication-helpers';
import type { CopyDeps } from '@/services/replication/outlook-snapshot-copier';

function manifest_key_for(manifest: OneDriveSnapshotManifest): string {
  return `${OD_MANIFEST_PREFIX}/${manifest.owner_id}/${manifest.snapshot_id}.json`;
}

/**
 * Copies a OneDrive snapshot into a context the caller has already opened and DEK-validated.
 *
 * Validation is deliberately not repeated here. Whether two buckets share a DEK is a property of
 * the pair, not of the snapshot, and `validate_dek_match` unwraps both wrapped DEKs, which is two
 * scrypt derivations at N=65536. Doing that per snapshot cost more than the copy on small
 * snapshots (issue #206), so the replication loop validates once per target and calls this.
 */
export async function copy_onedrive_snapshot_into_context(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: OneDriveSnapshotManifest,
  ancillary_keys: string[],
  target_id: string,
  is_rehydration = false,
): Promise<ReplicationResult> {
  const start = Date.now();
  const rep = await replicate_onedrive_snapshot(
    source_ctx,
    target_ctx,
    manifest,
    manifest_key_for(manifest),
    { skip_marker: is_rehydration, ancillary_keys },
  );
  return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
}

/**
 * Copies a OneDrive snapshot to a target it opens itself, destroying the target context even
 * when the copy throws.
 *
 * `create_context` derives an EnvelopeKeyService from the target passphrase and `destroy()` is
 * what zeroes that buffer, so without the `finally` the material was left for garbage collection
 * once per copied snapshot, on the success path as well as every failure (issue #200). Mirrors
 * `copy_outlook_snapshot_to_target`, which has always closed its target.
 *
 * For more than one snapshot against the same target, open one context and use
 * `copy_onedrive_snapshot_into_context` instead: this opens and validates per call.
 */
export async function copy_onedrive_snapshot_to_target(
  source_ctx: TenantContext,
  target: StorageTarget,
  manifest: OneDriveSnapshotManifest,
  ancillary_keys: string[],
  deps: CopyDeps,
): Promise<ReplicationResult> {
  const target_ctx = await target.create_context(deps.tenant_id);
  try {
    await deps.validate_dek(
      source_ctx.storage,
      target_ctx.storage,
      deps.passphrase,
      deps.tenant_id,
    );
    return await copy_onedrive_snapshot_into_context(
      source_ctx,
      target_ctx,
      manifest,
      ancillary_keys,
      target.target_id,
    );
  } finally {
    target_ctx.destroy();
  }
}

/**
 * Copies a OneDrive snapshot between two contexts the caller owns and closes, validating the DEK
 * pair first.
 *
 * `is_rehydration` suppresses the replica marker, so recovered data on primary is not labelled
 * as a replica of itself.
 */
export async function copy_onedrive_snapshot_between(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: OneDriveSnapshotManifest,
  ancillary_keys: string[],
  target_id: string,
  deps: CopyDeps,
  is_rehydration = false,
): Promise<ReplicationResult> {
  await deps.validate_dek(source_ctx.storage, target_ctx.storage, deps.passphrase, deps.tenant_id);
  return copy_onedrive_snapshot_into_context(
    source_ctx,
    target_ctx,
    manifest,
    ancillary_keys,
    target_id,
    is_rehydration,
  );
}
