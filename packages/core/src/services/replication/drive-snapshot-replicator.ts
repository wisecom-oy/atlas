import { createHash } from 'node:crypto';
import type { TenantContext } from '@wisecom/atlas-types';
import type { ReplicationObjectResult } from '@wisecom/atlas-types';

/** The only part of a drive manifest the copy path reads. */
export interface DriveObjectManifest {
  readonly entries: ReadonlyArray<{ readonly storage_key?: string | undefined }>;
}

export interface DriveReplicationTally {
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
  readonly source_manifest_checksum: string;
  readonly replicated_manifest_checksum: string;
}

/**
 * Every drive manifest entry that still has content, deleted entries carry no storage key.
 *
 * OneDrive and SharePoint manifests differ in their owning segment, never in their entries, so
 * this and everything below it work off the entry shape rather than a provider type.
 */
export function collect_drive_storage_keys(manifest: DriveObjectManifest): string[] {
  const keys: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.storage_key) keys.push(entry.storage_key);
  }
  return keys;
}

export interface DriveReplicateOptions {
  readonly skip_marker?: boolean;
  /** Additional S3 keys to copy alongside manifest entries (e.g. version indexes, delta cursors). */
  readonly ancillary_keys?: string[];
}

/**
 * Replicates a single drive snapshot from source to target.
 * Copies: DEK -> replica marker -> data blobs -> ancillary objects (indexes, cursors) -> manifest (always last).
 */
export async function replicate_drive_snapshot_objects(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: DriveObjectManifest,
  manifest_key: string,
  options: DriveReplicateOptions = {},
): Promise<DriveReplicationTally> {
  await ensure_dek_on_target(source_ctx, target_ctx);
  if (!options.skip_marker) {
    await ensure_replica_marker(target_ctx, source_ctx.tenant_id);
  }

  const storage_keys = collect_drive_storage_keys(manifest);
  const all_keys = [...storage_keys, ...(options.ancillary_keys ?? [])];
  const tally = await copy_keys_with_tally(source_ctx, target_ctx, all_keys);

  // A manifest is what makes a snapshot reachable, so a partial copy must leave none behind.
  // diff_drive_manifests decides "already replicated" from manifest presence alone, so writing one
  // after a failed blob copy makes the failure sticky: the next run skips the snapshot and never
  // retries the missing objects. Mirrors the Outlook gate in replicate_snapshot_to_target.
  if (tally.objects_failed > 0) {
    return { ...tally, source_manifest_checksum: '', replicated_manifest_checksum: '' };
  }

  const source_manifest_blob = await source_ctx.storage.get(manifest_key);
  const source_manifest_checksum = sha256_hex(source_manifest_blob);
  await target_ctx.storage.put(manifest_key, source_manifest_blob);
  const target_manifest_blob = await target_ctx.storage.get(manifest_key);
  const replicated_manifest_checksum = sha256_hex(target_manifest_blob);

  return {
    ...tally,
    source_manifest_checksum,
    replicated_manifest_checksum,
  };
}

const DEK_META_KEY = '_meta/dek.enc';
const REPLICA_MARKER_KEY = '_meta/replica.marker';

async function copy_keys_with_tally(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  keys: string[],
): Promise<{
  objects_copied: number;
  objects_skipped: number;
  objects_failed: number;
  bytes_copied: number;
  errors: string[];
}> {
  let objects_copied = 0;
  let objects_skipped = 0;
  let objects_failed = 0;
  let bytes_copied = 0;
  const errors: string[] = [];

  for (const key of keys) {
    const result = await copy_object(source_ctx, target_ctx, key);
    if (result.outcome === 'copied') {
      objects_copied++;
      bytes_copied += (await source_ctx.storage.get(key)).length;
    } else if (result.outcome === 'skipped') {
      objects_skipped++;
    } else {
      objects_failed++;
      if (result.error) errors.push(`${key}: ${result.error}`);
    }
  }

  return { objects_copied, objects_skipped, objects_failed, bytes_copied, errors };
}

async function copy_object(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  key: string,
): Promise<ReplicationObjectResult> {
  try {
    if (await target_ctx.storage.exists(key)) return { storage_key: key, outcome: 'skipped' };
    const data = await source_ctx.storage.get(key);
    await target_ctx.storage.put(key, data);
    return { storage_key: key, outcome: 'copied' };
  } catch (err) {
    return {
      storage_key: key,
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ensure_dek_on_target(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
): Promise<void> {
  if (await target_ctx.storage.exists(DEK_META_KEY)) return;
  const dek_blob = await source_ctx.storage.get(DEK_META_KEY);
  await target_ctx.storage.put(DEK_META_KEY, dek_blob);
}

async function ensure_replica_marker(ctx: TenantContext, source_tenant_id: string): Promise<void> {
  if (await ctx.storage.exists(REPLICA_MARKER_KEY)) return;
  const marker = { replicated_from_tenant: source_tenant_id, created_at: new Date().toISOString() };
  await ctx.storage.put(REPLICA_MARKER_KEY, Buffer.from(JSON.stringify(marker), 'utf-8'));
}

function sha256_hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
