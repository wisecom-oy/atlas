import type { TenantContext } from '@atlas/types';
import type { OneDriveSnapshotManifest } from '@atlas/types';
import type { ReplicationResult, ReplicationStatusRecord } from '@atlas/types';
import type { StorageTarget } from '@atlas/types';

export const OD_MANIFEST_PREFIX = 'onedrive/manifests';
export const OD_INDEX_PREFIX = 'onedrive/index';
export const OD_META_PREFIX = 'onedrive/_meta';

/** Builds a ReplicationStatusRecord from a replication result for persistence. */
export function to_onedrive_status_record(
  result: ReplicationResult,
  target: StorageTarget,
  manifest: OneDriveSnapshotManifest,
): ReplicationStatusRecord {
  const last_err = result.errors.length > 0 ? result.errors[result.errors.length - 1] : undefined;
  return {
    target_id: target.target_id,
    target_endpoint: target.endpoint,
    snapshot_id: manifest.snapshot_id,
    owner_id: manifest.owner_id,
    status: result.status,
    started_at: new Date(Date.now() - result.elapsed_ms).toISOString(),
    completed_at: new Date().toISOString(),
    objects_total: result.objects_total,
    objects_copied: result.objects_copied,
    objects_skipped: result.objects_skipped,
    objects_failed: result.objects_failed,
    bytes_total: manifest.total_size_bytes,
    bytes_copied: result.bytes_copied,
    ...(last_err !== undefined ? { last_error: last_err } : {}),
    verification_status: result.verification_status,
    source_manifest_checksum: result.source_manifest_checksum ?? '',
    replicated_manifest_checksum: result.replicated_manifest_checksum ?? '',
  };
}

/** Collects ancillary S3 keys for an owner: version indexes + delta cursor. */
export async function collect_od_ancillary_keys(
  ctx: TenantContext,
  owner_id: string,
): Promise<string[]> {
  const keys: string[] = [];
  const index_keys = await ctx.storage.list(`${OD_INDEX_PREFIX}/${owner_id}/files/`);
  keys.push(...index_keys);
  const cursor_key = `${OD_META_PREFIX}/${owner_id}/delta.json`;
  if (await ctx.storage.exists(cursor_key)) keys.push(cursor_key);
  return keys;
}

/** Finds manifests on source that are missing from the target. */
export async function diff_od_manifests(
  source: OneDriveSnapshotManifest[],
  target_ctx: TenantContext,
  owner_id: string,
): Promise<OneDriveSnapshotManifest[]> {
  const target_keys = await target_ctx.storage.list(`${OD_MANIFEST_PREFIX}/${owner_id}/`);
  const ids = new Set(
    target_keys.map((k) => k.split('/').pop()?.replace('.json', '')).filter(Boolean) as string[],
  );
  return source.filter((m) => !ids.has(m.snapshot_id));
}
