import type { TenantContext } from '@atlas/types';
import type { SharePointSnapshotManifest } from '@atlas/types';
import type { ReplicationResult, ReplicationStatusRecord } from '@atlas/types';
import type { StorageTarget } from '@atlas/types';

export const SP_MANIFEST_PREFIX = 'sharepoint/manifests';
export const SP_INDEX_PREFIX = 'sharepoint/index';
export const SP_META_PREFIX = 'sharepoint/_meta';

/** Builds a ReplicationStatusRecord from a SharePoint replication result for persistence. */
export function to_sharepoint_status_record(
  result: ReplicationResult,
  target: StorageTarget,
  manifest: SharePointSnapshotManifest,
): ReplicationStatusRecord {
  const last_err = result.errors.length > 0 ? result.errors[result.errors.length - 1] : undefined;
  return {
    target_id: target.target_id,
    target_endpoint: target.endpoint,
    snapshot_id: manifest.snapshot_id,
    owner_id: manifest.site_id,
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

/** Collects ancillary S3 keys for a site: version indexes + delta cursor. */
export async function collect_sp_ancillary_keys(
  ctx: TenantContext,
  site_id: string,
): Promise<string[]> {
  const keys: string[] = [];
  const index_keys = await ctx.storage.list(`${SP_INDEX_PREFIX}/${site_id}/files/`);
  keys.push(...index_keys);
  const cursor_key = `${SP_META_PREFIX}/${site_id}/delta.json`;
  if (await ctx.storage.exists(cursor_key)) keys.push(cursor_key);
  return keys;
}

/** Finds manifests on source that are missing from the target. */
export async function diff_sp_manifests(
  source: SharePointSnapshotManifest[],
  target_ctx: TenantContext,
  site_id: string,
): Promise<SharePointSnapshotManifest[]> {
  const target_keys = await target_ctx.storage.list(`${SP_MANIFEST_PREFIX}/${site_id}/`);
  const ids = new Set(
    target_keys.map((k) => k.split('/').pop()?.replace('.json', '')).filter(Boolean) as string[],
  );
  return source.filter((m) => !ids.has(m.snapshot_id));
}
