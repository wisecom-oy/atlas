import type { ReplicationResult, StorageTarget, TenantContext } from '@wisecom/atlas-types';
import {
  drive_manifest_key,
  type DriveReplicationDescriptor,
} from '@/services/replication/drive-replication-descriptor';
import {
  replicate_drive_snapshot_objects,
  type DriveObjectManifest,
} from '@/services/replication/drive-snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';
import type { CopyDeps } from '@/services/replication/outlook-snapshot-copier';

type DriveManifest = DriveObjectManifest & { readonly snapshot_id: string };

/**
 * Copies a drive snapshot into a context the caller has already opened and DEK-validated.
 *
 * Validation is deliberately not repeated here. Whether two buckets share a DEK is a property of
 * the pair, not of the snapshot, and `validate_dek_match` unwraps both wrapped DEKs, which is two
 * scrypt derivations at N=65536. Doing that per snapshot cost more than the copy on small
 * snapshots (issue #206), so the replication loop validates once per target and calls this.
 */
export async function copy_drive_snapshot_into_context<TManifest extends DriveManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: TManifest,
  ancillary_keys: string[],
  target_id: string,
  is_rehydration = false,
): Promise<ReplicationResult> {
  const start = Date.now();
  const rep = await replicate_drive_snapshot_objects(
    source_ctx,
    target_ctx,
    manifest,
    drive_manifest_key(descriptor, manifest),
    { skip_marker: is_rehydration, ancillary_keys },
  );
  return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
}

/**
 * Copies a drive snapshot to a target it opens itself, destroying the target context even when
 * the copy throws.
 *
 * `create_context` derives an EnvelopeKeyService from the target passphrase and `destroy()` is
 * what zeroes that buffer, so without the `finally` the material was left for garbage collection
 * once per copied snapshot, on the success path as well as every failure (issue #200). Mirrors
 * `copy_outlook_snapshot_to_target`, which has always closed its target.
 *
 * For more than one snapshot against the same target, open one context and use
 * `copy_drive_snapshot_into_context` instead: this opens and validates per call.
 */
export async function copy_drive_snapshot_to_target<TManifest extends DriveManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  source_ctx: TenantContext,
  target: StorageTarget,
  manifest: TManifest,
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
    return await copy_drive_snapshot_into_context(
      descriptor,
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
 * Copies a drive snapshot between two contexts the caller owns and closes, validating the DEK
 * pair first.
 *
 * `is_rehydration` suppresses the replica marker, so recovered data on primary is not labelled
 * as a replica of itself.
 */
export async function copy_drive_snapshot_between<TManifest extends DriveManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: TManifest,
  ancillary_keys: string[],
  target_id: string,
  deps: CopyDeps,
  is_rehydration = false,
): Promise<ReplicationResult> {
  await deps.validate_dek(source_ctx.storage, target_ctx.storage, deps.passphrase, deps.tenant_id);
  return copy_drive_snapshot_into_context(
    descriptor,
    source_ctx,
    target_ctx,
    manifest,
    ancillary_keys,
    target_id,
    is_rehydration,
  );
}
