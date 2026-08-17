import type {
  DekValidationFn,
  ReplicationResult,
  SharePointSnapshotManifest,
  StorageTarget,
  TenantContext,
} from '@wisecom/atlas-types';
import { replicate_sharepoint_snapshot } from '@/services/replication/sharepoint-snapshot-replicator';
import { build_replication_result } from '@/services/replication/replication-result-builder';
import { SP_MANIFEST_PREFIX } from '@/services/replication/sharepoint-replication-helpers';

function manifest_key_of(manifest: SharePointSnapshotManifest): string {
  return `${SP_MANIFEST_PREFIX}/${manifest.site_id}/${manifest.snapshot_id}.json`;
}

/** Copies one SharePoint snapshot to a target, opening and releasing that target's context. */
export async function copy_sharepoint_snapshot_to_target(
  source_ctx: TenantContext,
  target: StorageTarget,
  manifest: SharePointSnapshotManifest,
  ancillary_keys: string[],
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
): Promise<ReplicationResult> {
  const start = Date.now();
  const target_ctx = await target.create_context(tenant_id);
  await validate_dek(source_ctx.storage, target_ctx.storage, passphrase, tenant_id);
  const rep = await replicate_sharepoint_snapshot(
    source_ctx,
    target_ctx,
    manifest,
    manifest_key_of(manifest),
    { ancillary_keys },
  );
  return build_replication_result(rep, manifest.snapshot_id, target.target_id, Date.now() - start);
}

/**
 * Copies one SharePoint snapshot between two open contexts.
 *
 * `is_rehydration` suppresses the replica marker: the primary must not be stamped as a replica of
 * the replica it was recovered from.
 */
export async function copy_sharepoint_snapshot_between(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: SharePointSnapshotManifest,
  ancillary_keys: string[],
  target_id: string,
  tenant_id: string,
  validate_dek: DekValidationFn,
  passphrase: string,
  is_rehydration = false,
): Promise<ReplicationResult> {
  const start = Date.now();
  await validate_dek(source_ctx.storage, target_ctx.storage, passphrase, tenant_id);
  const rep = await replicate_sharepoint_snapshot(
    source_ctx,
    target_ctx,
    manifest,
    manifest_key_of(manifest),
    { skip_marker: is_rehydration, ancillary_keys },
  );
  return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
}
