import type {
  DekValidationFn,
  Manifest,
  ReplicationResult,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';

export interface CopyDeps {
  readonly validate_dek: DekValidationFn;
  readonly passphrase: string;
  readonly tenant_id: string;
}

/**
 * Copies an Outlook snapshot to a target it has to open itself, closing the target context
 * even when the copy throws. Used by the replicate paths, where the target is a configured
 * replica rather than an already-open context.
 */
export async function copy_outlook_snapshot_to_target(
  source_ctx: TenantContext,
  target: StorageTarget,
  manifest: Manifest,
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
    const rep = await replicate_snapshot_to_target(source_ctx, target_ctx, manifest);
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
 * Copies an Outlook snapshot between two open contexts. `is_rehydration` suppresses the replica
 * marker, so recovered data on primary is not labelled as a replica of itself.
 */
export async function copy_outlook_snapshot_between(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: Manifest,
  target_id: string,
  deps: CopyDeps,
  is_rehydration = false,
): Promise<ReplicationResult> {
  const start = Date.now();
  await deps.validate_dek(source_ctx.storage, target_ctx.storage, deps.passphrase, deps.tenant_id);
  const rep = await replicate_snapshot_to_target(source_ctx, target_ctx, manifest, {
    skip_marker: is_rehydration,
  });
  return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
}
