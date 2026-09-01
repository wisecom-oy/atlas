import type { TenantContext } from '@wisecom/atlas-types';
import type { StorageTarget, DekValidationFn } from '@wisecom/atlas-types';
import type { ReplicationResult } from '@wisecom/atlas-types';
import { build_replication_result } from '@/services/replication/replication-result-builder';
import type { DriveReplicationTally } from '@/services/replication/drive-snapshot-replicator';

/**
 * What a workload contributes to rehydration: where its manifest lives on the primary, and how to
 * copy one snapshot back. Outlook, OneDrive and SharePoint differ in nothing else here.
 */
export interface RehydrationPlan<TManifest> {
  /** Key the manifest occupies on the primary, used to decide whether the snapshot is already there. */
  readonly manifest_key: (manifest: TManifest) => string;
  /** Copies one snapshot from source to primary, without writing a replica marker. */
  readonly replicate: (
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    manifest: TManifest,
    manifest_key: string,
  ) => Promise<DriveReplicationTally>;
}

/**
 * Rehydrates multiple manifests from a source target back to the primary, skipping manifests that
 * already exist on the primary.
 */
export async function rehydrate_manifests<TManifest extends { snapshot_id: string }>(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  manifests: TManifest[],
  source: StorageTarget,
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
  plan: RehydrationPlan<TManifest>,
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
    const key = plan.manifest_key(manifest);
    if (await primary_ctx.storage.exists(key)) {
      total_skipped++;
      continue;
    }

    const rep = await plan.replicate(source_ctx, primary_ctx, manifest, key);
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
