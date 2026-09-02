import type { TenantContext } from '@wisecom/atlas-types';
import type { ReplicationResult, ReplicationStatusRecord } from '@wisecom/atlas-types';
import type { StorageTarget } from '@wisecom/atlas-types';
import type { DriveReplicationDescriptor } from '@/services/replication/drive-replication-descriptor';

interface DriveManifestShape {
  readonly snapshot_id: string;
  readonly total_size_bytes: number;
}

/** Builds a ReplicationStatusRecord from a drive replication result for persistence. */
export function to_drive_status_record<TManifest extends DriveManifestShape>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  result: ReplicationResult,
  target: StorageTarget,
  manifest: TManifest,
): ReplicationStatusRecord {
  const last_err = result.errors.length > 0 ? result.errors[result.errors.length - 1] : undefined;
  return {
    target_id: target.target_id,
    target_endpoint: target.endpoint,
    snapshot_id: manifest.snapshot_id,
    owner_id: descriptor.owner_id_of(manifest),
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

/**
 * Collects ancillary S3 keys for one owner: version indexes + delta cursor.
 * The index prefix is the owner root, not `files/`: since issue #161 version
 * rows live in per-run objects under `runs/`, and scoping to `files/` would
 * replicate only the legacy per-file objects.
 */
export async function collect_drive_ancillary_keys<TManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  ctx: TenantContext,
  owner_id: string,
): Promise<string[]> {
  const keys: string[] = [];
  const index_keys = await ctx.storage.list(`${descriptor.index_prefix}/${owner_id}/`);
  keys.push(...index_keys);
  const cursor_key = `${descriptor.meta_prefix}/${owner_id}/delta.json`;
  if (await ctx.storage.exists(cursor_key)) keys.push(cursor_key);
  return keys;
}

/** Finds manifests on source that are missing from the target. */
export async function diff_drive_manifests<TManifest extends DriveManifestShape>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  source: TManifest[],
  target_ctx: TenantContext,
  owner_id: string,
): Promise<TManifest[]> {
  const target_keys = await target_ctx.storage.list(`${descriptor.manifest_prefix}/${owner_id}/`);
  const ids = new Set(
    target_keys.map((k) => k.split('/').pop()?.replace('.json', '')).filter(Boolean) as string[],
  );
  return source.filter((m) => !ids.has(m.snapshot_id));
}

/** Buckets manifests by their owning segment, so each owner is rehydrated as one unit. */
export function group_manifests_by_owner<TManifest>(
  descriptor: DriveReplicationDescriptor<TManifest>,
  manifests: TManifest[],
): Map<string, TManifest[]> {
  const by_owner = new Map<string, TManifest[]>();
  for (const manifest of manifests) {
    const owner_id = descriptor.owner_id_of(manifest);
    const bucket = by_owner.get(owner_id);
    if (bucket) bucket.push(manifest);
    else by_owner.set(owner_id, [manifest]);
  }
  return by_owner;
}
