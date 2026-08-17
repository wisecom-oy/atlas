import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { createHash, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveVerificationResult,
  OneDriveVerificationUseCase,
  TenantContext,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';

const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

/** Verifies OneDrive snapshot blobs against manifest checksums and index consistency. */
@injectable()
export class OneDriveVerificationService implements OneDriveVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
  ) {}

  /** Loads the manifest and checks content blobs plus per-file index rows for the snapshot. */
  async verify_onedrive_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<OneDriveVerificationResult> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create(tenant_id);
    options.on_progress?.({
      operation: 'verify',
      workload: 'onedrive',
      phase: 'discovering',
      processed: 0,
    });
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, owner_id, snapshot_id);
      if (!manifest) {
        throw new Error(`No OneDrive manifest found for snapshot ${snapshot_id}`);
      }

      const failed_file_ids: string[] = [];
      const index_issues: string[] = [];
      let total_checked = 0;
      let processed = 0;
      options.on_progress?.({
        operation: 'verify',
        workload: 'onedrive',
        phase: 'processing',
        processed: 0,
        total: manifest.entries.length,
      });

      for (const entry of manifest.entries) {
        if (options.should_interrupt?.() === true) break;
        const idx = await this._indexes.find_by_file_id(ctx, manifest.owner_id, entry.file_id);
        const has_version = idx?.versions.some((v) => v.snapshot_id === snapshot_id);
        if (!has_version) {
          index_issues.push(
            `missing index version for file ${entry.file_id} snapshot ${snapshot_id}`,
          );
        }

        if (this.entry_has_blob(entry)) {
          const corrupt = await this.is_blob_corrupt(ctx, entry);
          total_checked++;
          if (corrupt) failed_file_ids.push(entry.file_id);
        }
        processed++;
        options.on_progress?.({
          operation: 'verify',
          workload: 'onedrive',
          phase: 'processing',
          processed,
          total: manifest.entries.length,
          current: entry.file_name,
        });
      }
      const interrupted = options.should_interrupt?.() === true;
      options.on_progress?.({
        operation: 'verify',
        workload: 'onedrive',
        phase: interrupted ? 'interrupted' : 'completed',
        processed,
        total: manifest.entries.length,
      });

      return {
        snapshot_id,
        total_checked,
        passed: total_checked - failed_file_ids.length,
        failed_file_ids,
        index_issues,
        interrupted,
      };
    } finally {
      ctx.destroy();
    }
  }

  private entry_has_blob(entry: OneDriveManifestEntry): boolean {
    return (
      entry.change_type !== 'deleted' &&
      entry.storage_key !== undefined &&
      entry.storage_key.length > 0 &&
      entry.checksum !== undefined &&
      entry.checksum.length > 0
    );
  }

  private async is_blob_corrupt(
    ctx: TenantContext,
    entry: OneDriveManifestEntry,
  ): Promise<boolean> {
    const storage_key = entry.storage_key;
    const expected = entry.checksum;
    if (!storage_key || !expected) return true;
    try {
      if (!(await ctx.storage.exists(storage_key))) return true;
      const ciphertext = await ctx.storage.get(storage_key);
      const plaintext = ctx.decrypt(ciphertext);
      const actual = compute_sha256_chunked(plaintext);
      return this.is_checksum_mismatch(actual, expected);
    } catch {
      return true;
    }
  }

  private is_checksum_mismatch(actual_checksum: string, expected_checksum: string): boolean {
    if (actual_checksum.length !== expected_checksum.length) return true;
    const a = Buffer.from(actual_checksum, 'utf8');
    const b = Buffer.from(expected_checksum, 'utf8');
    return !timingSafeEqual(a, b);
  }
}

function compute_sha256_chunked(data: Buffer): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < data.length; offset += HASH_CHUNK_SIZE) {
    hash.update(data.subarray(offset, Math.min(offset + HASH_CHUNK_SIZE, data.length)));
  }
  return hash.digest('hex');
}
