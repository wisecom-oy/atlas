import type { TenantContext } from '@wisecom/atlas-types';
import type { Manifest } from '@wisecom/atlas-types';
import type { StorageTarget, DekValidationFn } from '@wisecom/atlas-types';
import type { ReplicationResult } from '@wisecom/atlas-types';
import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';

/**
 * Rehydrates multiple manifests from a source target back to the primary,
 * skipping manifests that already exist on the primary.
 */
export async function rehydrate_manifests(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  manifests: Manifest[],
  source: StorageTarget,
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
): Promise<ReplicationResult> {
  const start = Date.now();
  await validate_dek(source_ctx.storage, primary_ctx.storage, passphrase, tenant_id);

  let total_copied = 0;
  let total_skipped = 0;
  let total_failed = 0;
  let total_bytes = 0;
  const all_errors: string[] = [];
  let snapshot_count = 0;

  for (const manifest of manifests) {
    const key = `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`;
    if (await primary_ctx.storage.exists(key)) {
      total_skipped++;
      continue;
    }

    const rep = await replicate_snapshot_to_target(source_ctx, primary_ctx, manifest, {
      skip_marker: true,
    });

    total_copied += rep.objects_copied;
    total_skipped += rep.objects_skipped;
    total_failed += rep.objects_failed;
    total_bytes += rep.bytes_copied;
    all_errors.push(...rep.errors);
    snapshot_count++;
  }

  const snapshot_label =
    manifests.length === 1 ? manifests[0]!.snapshot_id : `${snapshot_count}-snapshots`;

  return build_replication_result(
    {
      objects_copied: total_copied,
      objects_skipped: total_skipped,
      objects_failed: total_failed,
      bytes_copied: total_bytes,
      errors: all_errors,
    },
    snapshot_label,
    source.target_id,
    Date.now() - start,
  );
}
