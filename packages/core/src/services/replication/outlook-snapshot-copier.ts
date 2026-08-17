import type {
  DekValidationFn,
  Manifest,
  ReplicationResult,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';

/** Copies one Outlook snapshot to a target, opening and releasing that target's context. */
export async function copy_outlook_snapshot_to_target(
  source_ctx: TenantContext,
  target: StorageTarget,
  manifest: Manifest,
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
): Promise<ReplicationResult> {
  const start = Date.now();
  const target_ctx = await target.create_context(tenant_id);
  try {
    await validate_dek(source_ctx.storage, target_ctx.storage, passphrase, tenant_id);
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
 * Copies one Outlook snapshot between two open contexts.
 *
 * `is_rehydration` suppresses the replica marker: the primary must not be stamped as a replica of
 * the replica it was recovered from.
 */
export async function copy_outlook_snapshot_between(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: Manifest,
  target_id: string,
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
  is_rehydration = false,
): Promise<ReplicationResult> {
  const start = Date.now();
  await validate_dek(source_ctx.storage, target_ctx.storage, passphrase, tenant_id);
  const rep = await replicate_snapshot_to_target(source_ctx, target_ctx, manifest, {
    skip_marker: is_rehydration,
  });
  return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
}
