import type { TenantContext } from '@atlas/types';
import type { SharePointSnapshotManifest } from '@atlas/types';
import type { StorageTarget, DekValidationFn } from '@atlas/types';
import type { ReplicationResult } from '@atlas/types';
import { replicate_sharepoint_snapshot } from '@/services/replication/sharepoint-snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';

const SP_MANIFEST_PREFIX = 'sharepoint/manifests';

/**
 * Rehydrates multiple SharePoint manifests from a source target back to
 * the primary, skipping manifests that already exist on the primary.
 */
export async function rehydrate_sp_manifests(
  source_ctx: TenantContext,
  primary_ctx: TenantContext,
  manifests: SharePointSnapshotManifest[],
  ancillary_keys: string[],
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
    const key = `${SP_MANIFEST_PREFIX}/${manifest.site_id}/${manifest.snapshot_id}.json`;
    if (await primary_ctx.storage.exists(key)) {
      total_skipped++;
      continue;
    }

    const rep = await replicate_sharepoint_snapshot(source_ctx, primary_ctx, manifest, key, {
      skip_marker: true,
      ancillary_keys,
    });
    total_copied += rep.objects_copied;
    total_skipped += rep.objects_skipped;
    total_failed += rep.objects_failed;
    total_bytes += rep.bytes_copied;
    all_errors.push(...rep.errors);
    snapshot_count++;
  }

  const label = manifests.length === 1 ? manifests[0]!.snapshot_id : `${snapshot_count}-snapshots`;
  return build_replication_result(
    {
      objects_copied: total_copied,
      objects_skipped: total_skipped,
      objects_failed: total_failed,
      bytes_copied: total_bytes,
      errors: all_errors,
    },
    label,
    source.target_id,
    Date.now() - start,
  );
}
