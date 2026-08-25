import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { createHash, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  SharePointFileVersionIndexRepository,
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointVerificationResult,
  SharePointVerificationUseCase,
  TenantContext,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { load_sharepoint_chain_entries } from '@/services/sharepoint-manifest-chain';

const HASH_CHUNK_SIZE = 64 * 1024 * 1024;

/** Verifies SharePoint snapshot blobs against manifest checksums and index consistency. */
@injectable()
export class SharePointVerificationService implements SharePointVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
    @inject(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: SharePointFileVersionIndexRepository,
  ) {}

  /** Loads the manifest and checks content blobs plus per-file index rows for the snapshot. */
  async verify_sharepoint_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<SharePointVerificationResult> {
    site_id = normalize_owner_id(site_id);
    if (begin_operation_progress(options, 'verify', 'sharepoint')) {
      finish_operation_progress(options, 'verify', 'sharepoint', 0, 0);
      return {
        snapshot_id,
        total_checked: 0,
        passed: 0,
        failed_file_ids: [],
        index_issues: [],
        interrupted: true,
      };
    }
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      // The chain, not the single manifest: a snapshot inherits every file that last changed in an
      // earlier run, and verifying only the target would report those as checked when they were
      // never looked at (issue #173).
      const { manifest, entries } = await load_sharepoint_chain_entries(
        this._manifests,
        ctx,
        site_id,
        snapshot_id,
      );

      const failed_file_ids: string[] = [];
      const index_issues: string[] = [];
      let total_checked = 0;
      let processed = 0;
      emit_operation_progress(options, {
        operation: 'verify',
        workload: 'sharepoint',
        phase: 'processing',
        processed: 0,
        total: entries.length,
      });

      // One read of the site's merged version index instead of one lookup per
      // entry: the index is a handful of per-run objects since issue #161.
      const indexes_by_file = new Map(
        (await this._indexes.list_by_site(ctx, manifest.site_id)).map((idx) => [idx.file_id, idx]),
      );

      for (const { snapshot_id: source_snapshot, entry } of entries) {
        if (options.should_interrupt?.() === true) break;
        const idx = indexes_by_file.get(entry.file_id);
        // Against the snapshot that recorded the entry, not the one being verified: a carried-over
        // file has its index row under the older snapshot.
        const has_version = idx?.versions.some((v) => v.snapshot_id === source_snapshot);
        if (!has_version) {
          index_issues.push(
            `missing index version for file ${entry.file_id} snapshot ${source_snapshot}`,
          );
        }

        if (this.entry_has_blob(entry)) {
          total_checked++;
          const corrupt = await this.is_blob_corrupt(ctx, entry);
          if (corrupt) failed_file_ids.push(entry.file_id);
        }
        processed++;
        emit_operation_progress(options, {
          operation: 'verify',
          workload: 'sharepoint',
          phase: 'processing',
          processed,
          total: entries.length,
          current: entry.file_name,
        });
      }

      const interrupted = finish_operation_progress(
        options,
        'verify',
        'sharepoint',
        processed,
        entries.length,
        processed < entries.length,
      );

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

  private entry_has_blob(entry: SharePointManifestEntry): boolean {
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
    entry: SharePointManifestEntry,
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
