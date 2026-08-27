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
 * Copies a OneDrive snapshot to a target it opens itself, destroying the target context even
 * when the copy throws.
 *
 * `create_context` derives an EnvelopeKeyService from the target passphrase and `destroy()` is
 * what zeroes that buffer, so without the `finally` the material was left for garbage collection
 * once per copied snapshot, on the success path as well as every failure (issue #200). Mirrors
 * `copy_outlook_snapshot_to_target`, which has always closed its target.
 */
export async function copy_onedrive_snapshot_to_target(
  source_ctx: TenantContext,
  target: StorageTarget,
  manifest: OneDriveSnapshotManifest,
  ancillary_keys: string[],
  deps: CopyDeps,
): Promise<ReplicationResult> {
  const start = Date.now();
  const target_ctx = await target.create_context(deps.tenant_id);
  try {
    await deps.validate_dek(
      source_ctx.storage,
      target_ctx.storage,
      deps.passphrase,
      deps.tenant_id,
    );
    const rep = await replicate_onedrive_snapshot(
      source_ctx,
      target_ctx,
      manifest,
      manifest_key_for(manifest),
      { ancillary_keys },
    );
    return build_replication_result(
      rep,
      manifest.snapshot_id,
      target.target_id,
      Date.now() - start,
    );
  } finally {
    target_ctx.destroy();
  }
}

/**
 * Copies a OneDrive snapshot between two contexts the caller owns and closes.
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
  const start = Date.now();
  await deps.validate_dek(source_ctx.storage, target_ctx.storage, deps.passphrase, deps.tenant_id);
  const rep = await replicate_onedrive_snapshot(
    source_ctx,
    target_ctx,
    manifest,
    manifest_key_for(manifest),
    { skip_marker: is_rehydration, ancillary_keys },
  );
  return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
}
