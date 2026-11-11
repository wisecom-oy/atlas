import { createHash } from 'node:crypto';
import type { TenantContext } from '@wisecom/atlas-types';
import type { Manifest } from '@wisecom/atlas-types';
import type { ReplicationObjectResult } from '@wisecom/atlas-types';
import {
  ensure_dek_on_target,
  ensure_replica_marker,
} from '@/services/replication/replica-target-bootstrap';
import { copy_objects_to_target } from '@/services/replication/replication-object-copy';

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

export interface ReplicateOptions {
  readonly skip_marker?: boolean;
}

/**
 * Replicates a single snapshot from source to target.
 * Callers must validate DEK match before invoking.
 *
 * Order: DEK copy -> replica marker -> data+attachments -> manifest (always last).
 */
export async function replicate_snapshot_to_target(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  manifest: Manifest,
  options: ReplicateOptions = {},
): Promise<SnapshotReplicationResult> {
  await ensure_dek_on_target(source_ctx, target_ctx);
  if (!options.skip_marker) {
    await ensure_replica_marker(target_ctx, source_ctx.tenant_id);
  }

  const tally = await copy_objects_to_target(
    source_ctx,
    target_ctx,
    collect_storage_keys(manifest),
  );

  if (tally.objects_failed > 0) {
    return { ...tally, source_manifest_checksum: '', replicated_manifest_checksum: '' };
  }

  const manifest_key = `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`;
  const source_manifest_blob = await source_ctx.storage.get(manifest_key);
  const source_manifest_checksum = sha256_hex(source_manifest_blob);

  await target_ctx.storage.put(manifest_key, source_manifest_blob);

  const target_manifest_blob = await target_ctx.storage.get(manifest_key);
  const replicated_manifest_checksum = sha256_hex(target_manifest_blob);

  return { ...tally, source_manifest_checksum, replicated_manifest_checksum };
}

function sha256_hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
