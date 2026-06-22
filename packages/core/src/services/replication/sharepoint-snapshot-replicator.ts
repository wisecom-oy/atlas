import { createHash } from 'node:crypto';
import type { TenantContext } from '@wisecom/atlas-types';
import type { SharePointSnapshotManifest } from '@wisecom/atlas-types';
import type { ReplicationObjectResult } from '@wisecom/atlas-types';

export interface SharePointReplicationResult {
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
  readonly source_manifest_checksum: string;
  readonly replicated_manifest_checksum: string;
}

/** Collects every storage key referenced by a SharePoint manifest (skip deleted entries). */
export function collect_sharepoint_storage_keys(manifest: SharePointSnapshotManifest): string[] {
  const keys: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.storage_key) keys.push(entry.storage_key);
  }
  return keys;
}

export interface SharePointReplicateOptions {
  readonly skip_marker?: boolean;
  /** Additional S3 keys to copy alongside manifest entries (e.g. version indexes, delta cursors). */
  readonly ancillary_keys?: string[];
}

/**
 * Replicates a single SharePoint snapshot from source to target.
 * Copies: DEK -> replica marker -> data blobs -> ancillary objects (indexes, cursors) -> manifest (always last).
 */
export async function replicate_sharepoint_snapshot(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: SharePointSnapshotManifest,
  manifest_key: string,
  options: SharePointReplicateOptions = {},
): Promise<SharePointReplicationResult> {
  await ensure_dek_on_target(source_ctx, target_ctx);
  if (!options.skip_marker) {
    await ensure_replica_marker(target_ctx, source_ctx.tenant_id);
  }

  const storage_keys = collect_sharepoint_storage_keys(manifest);
  const all_keys = [...storage_keys, ...(options.ancillary_keys ?? [])];
  const tally = await copy_keys_with_tally(source_ctx, target_ctx, all_keys);

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
