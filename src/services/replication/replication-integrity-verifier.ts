import { createHash, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { Manifest } from '@/domain/manifest';
import { ReplicationVerificationStatus } from '@/domain/replication';
import { collect_storage_keys } from '@/services/replication/snapshot-replicator';

export interface VerificationOutcome {
  readonly status: ReplicationVerificationStatus;
  readonly checked: number;
  readonly failed_keys: string[];
}

/**
 * Verifies integrity of a replicated snapshot on the target by
 * decrypting each object and comparing its SHA-256 against the manifest checksum.
 */
export async function verify_replicated_snapshot(
  target_ctx: TenantContext,
  manifest: Manifest,
): Promise<VerificationOutcome> {
  const keys = collect_storage_keys(manifest);
  const checksum_map = build_checksum_map(manifest);
  const failed_keys: string[] = [];

  for (const key of keys) {
    const expected = checksum_map.get(key);
    if (!expected) continue;

    const is_valid = await verify_single_object(target_ctx, key, expected);
    if (!is_valid) failed_keys.push(key);
  }

  return {
    status:
      failed_keys.length === 0
        ? ReplicationVerificationStatus.PASSED
        : ReplicationVerificationStatus.FAILED,
    checked: keys.length,
    failed_keys,
  };
}

function build_checksum_map(manifest: Manifest): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of manifest.entries) {
    map.set(entry.storage_key, entry.checksum);
    if (entry.attachments) {
      for (const att of entry.attachments) {
        map.set(att.storage_key, att.checksum);
      }
    }
  }
  return map;
}

async function verify_single_object(
  ctx: TenantContext,
  key: string,
  expected_checksum: string,
): Promise<boolean> {
  try {
    const ciphertext = await ctx.storage.get(key);
    const plaintext = ctx.decrypt(ciphertext);
    const actual = createHash('sha256').update(plaintext).digest('hex');
    if (actual.length !== expected_checksum.length) return false;
    return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected_checksum, 'utf8'));
  } catch {
    return false;
  }
}
