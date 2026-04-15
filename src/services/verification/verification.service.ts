import { inject, injectable } from 'inversify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { TenantContextFactory, TenantContext } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { VerificationResult, VerificationUseCase } from '@/ports/verification/use-case.port';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';

@injectable()
export class VerificationService implements VerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Verifies the integrity of every object in a backup snapshot by:
   *   1. Downloading the encrypted blob
   *   2. Decrypting with the tenant DEK
   *   3. Recomputing SHA-256 and comparing to the manifest checksum
   */
  async verify_snapshot_integrity(
    tenant_id: string,
    snapshot_id: string,
  ): Promise<VerificationResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this.load_manifest_for_snapshot(ctx, snapshot_id);
      const failed_ids = await this.check_all_entries(ctx, manifest.entries);
      return this.build_verification_result(snapshot_id, manifest.entries.length, failed_ids);
    } finally {
      ctx.destroy();
    }
  }

  /** Loads the manifest for a snapshot, throwing if none exists. */
  private async load_manifest_for_snapshot(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) {
      throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    }
    return manifest;
  }

  /** Checks every entry and returns the object IDs that failed verification. */
  private async check_all_entries(ctx: TenantContext, entries: ManifestEntry[]): Promise<string[]> {
    const failed: string[] = [];
    for (const entry of entries) {
      const is_corrupt = await this.is_entry_corrupt(ctx, entry);
      if (is_corrupt) {
        failed.push(entry.object_id);
      }
    }
    return failed;
  }

  /**
   * Downloads, decrypts, and hashes a single entry.
   * Returns true if the entry is missing, decryption fails (tampered), or checksum mismatches.
   */
  private async is_entry_corrupt(ctx: TenantContext, entry: ManifestEntry): Promise<boolean> {
    try {
      const exists = await ctx.storage.exists(entry.storage_key);
      if (!exists) return true;

      const ciphertext = await ctx.storage.get(entry.storage_key);
      const plaintext = ctx.decrypt(ciphertext);
      const actual_checksum = this.compute_sha256(plaintext);
      return this.is_checksum_mismatch(actual_checksum, entry.checksum);
    } catch {
      return true;
    }
  }

  /** Returns the SHA-256 hex digest of the given buffer. */
  private compute_sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Compares checksums in constant time when lengths match.
   * Returns true for any mismatch or malformed length.
   */
  private is_checksum_mismatch(actual_checksum: string, expected_checksum: string): boolean {
    if (actual_checksum.length !== expected_checksum.length) {
      return true;
    }

    const actual = Buffer.from(actual_checksum, 'utf8');
    const expected = Buffer.from(expected_checksum, 'utf8');
    return !timingSafeEqual(actual, expected);
  }

  /** Assembles the final verification result from raw counts. */
  private build_verification_result(
    snapshot_id: string,
    total_checked: number,
    failed: string[],
  ): VerificationResult {
    return {
      snapshot_id,
      total_checked,
      passed: total_checked - failed.length,
      failed,
    };
  }
}
