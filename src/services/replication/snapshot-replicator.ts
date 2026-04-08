import { createHash } from 'node:crypto';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { Manifest } from '@/domain/manifest';
import type { ReplicationObjectResult } from '@/domain/replication';
import { validate_dek_match } from '@/adapters/storage-s3/dek-validator';

const DEK_META_KEY = '_meta/dek.enc';
const REPLICA_MARKER_KEY = '_meta/replica.marker';

export interface SnapshotReplicationResult {
  readonly object_results: ReplicationObjectResult[];
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
  readonly source_manifest_checksum: string;
  readonly replicated_manifest_checksum: string;
}

/** Collects every storage key (data + attachments) referenced by a manifest. */
export function collect_storage_keys(manifest: Manifest): string[] {
  const keys: string[] = [];
  for (const entry of manifest.entries) {
    keys.push(entry.storage_key);
    if (entry.attachments) {
      for (const att of entry.attachments) {
        keys.push(att.storage_key);
      }
    }
  }
  return keys;
}

/**
 * Replicates a single snapshot from source to target.
 *
 * Ordering guarantees:
 *   1. DEK validation + copy
 *   2. Replica marker
 *   3. Data + attachment objects
 *   4. Manifest (always last)
 */
export async function replicate_snapshot_to_target(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: Manifest,
  passphrase: string,
  tenant_id: string,
): Promise<SnapshotReplicationResult> {
  await validate_dek_match(source_ctx.storage, target_ctx.storage, passphrase, tenant_id);
  await ensure_dek_on_target(source_ctx, target_ctx);
  await ensure_replica_marker(target_ctx, source_ctx.tenant_id);

  const storage_keys = collect_storage_keys(manifest);
  const object_results: ReplicationObjectResult[] = [];
  let objects_copied = 0;
  let objects_skipped = 0;
  let objects_failed = 0;
  let bytes_copied = 0;
  const errors: string[] = [];

  for (const key of storage_keys) {
    const result = await copy_object(source_ctx, target_ctx, key);
    object_results.push(result);
    if (result.outcome === 'copied') {
      objects_copied++;
      const data = await source_ctx.storage.get(key);
      bytes_copied += data.length;
    } else if (result.outcome === 'skipped') {
      objects_skipped++;
    } else {
      objects_failed++;
      if (result.error) errors.push(`${key}: ${result.error}`);
    }
  }

  const manifest_key = `manifests/${manifest.mailbox_id}/${manifest.snapshot_id}.json`;
  const source_manifest_blob = await source_ctx.storage.get(manifest_key);
  const source_manifest_checksum = sha256_hex(source_manifest_blob);

  await target_ctx.storage.put(manifest_key, source_manifest_blob);

  const target_manifest_blob = await target_ctx.storage.get(manifest_key);
  const replicated_manifest_checksum = sha256_hex(target_manifest_blob);

  return {
    object_results,
    objects_copied,
    objects_skipped,
    objects_failed,
    bytes_copied,
    errors,
    source_manifest_checksum,
    replicated_manifest_checksum,
  };
}

async function copy_object(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  key: string,
): Promise<ReplicationObjectResult> {
  try {
    const exists = await target_ctx.storage.exists(key);
    if (exists) return { storage_key: key, outcome: 'skipped' };

    const data = await source_ctx.storage.get(key);
    await target_ctx.storage.put(key, data);
    return { storage_key: key, outcome: 'copied' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { storage_key: key, outcome: 'failed', error: message };
  }
}

async function ensure_dek_on_target(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
): Promise<void> {
  const target_has_dek = await target_ctx.storage.exists(DEK_META_KEY);
  if (target_has_dek) return;

  const dek_blob = await source_ctx.storage.get(DEK_META_KEY);
  await target_ctx.storage.put(DEK_META_KEY, dek_blob);
}

async function ensure_replica_marker(ctx: TenantContext, source_tenant_id: string): Promise<void> {
  const has_marker = await ctx.storage.exists(REPLICA_MARKER_KEY);
  if (has_marker) return;

  const marker = {
    replicated_from_tenant: source_tenant_id,
    created_at: new Date().toISOString(),
  };
  const data = Buffer.from(JSON.stringify(marker), 'utf-8');
  await ctx.storage.put(REPLICA_MARKER_KEY, data);
}

function sha256_hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
