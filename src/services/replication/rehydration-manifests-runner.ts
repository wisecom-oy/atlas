import type { TenantContext } from '@/ports/tenant/context.port';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { DekValidationFn } from '@/ports/replication/dek-validation.port';
import type { ReplicationResult } from '@/domain/replication';
import type { Manifest } from '@/domain/manifest';
import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';

/**
 * Iterates over a set of manifests and copies any that are missing from
 * primary storage. Used by both rehydrate_mailbox and rehydrate_tenant.
 */
export async function run_manifest_rehydration(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  manifests: Manifest[],
  source: StorageTarget,
  tenant_id: string,
  validate_dek: DekValidationFn,
  encryption_passphrase: string,
): Promise<ReplicationResult> {
  const start = Date.now();

  let total_copied = 0;
  let total_skipped = 0;
  let total_failed = 0;
  let total_bytes = 0;
  const all_errors: string[] = [];
  let snapshot_count = 0;

  for (const manifest of manifests) {
    const key = `manifests/${manifest.mailbox_id}/${manifest.snapshot_id}.json`;
    if (await primary_ctx.storage.exists(key)) {
      total_skipped++;
      continue;
    }

    await validate_dek(source_ctx.storage, primary_ctx.storage, encryption_passphrase, tenant_id);

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
