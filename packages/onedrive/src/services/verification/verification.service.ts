import { stream_sha256_from_storage } from '@wisecom/atlas-core/services/shared/stream-decrypt';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { timingSafeEqual } from 'node:crypto';
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
import { load_onedrive_chain_entries } from '@/services/shared/manifest-chain';

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
    if (begin_operation_progress(options, 'verify', 'onedrive')) {
      finish_operation_progress(options, 'verify', 'onedrive', 0, 0);
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
      const { manifest, entries } = await load_onedrive_chain_entries(
        this._manifests,
        ctx,
        owner_id,
        snapshot_id,
      );

      const failed_file_ids: string[] = [];
      const index_issues: string[] = [];
      let total_checked = 0;
      let processed = 0;
      // One read of the owner's merged version index instead of one lookup per
      // entry: the index is a handful of per-run objects since issue #161.
      const indexes_by_file = new Map(
        (await this._indexes.list_by_owner(ctx, manifest.owner_id)).map((idx) => [
          idx.file_id,
          idx,
        ]),
      );
      emit_operation_progress(options, {
        operation: 'verify',
        workload: 'onedrive',
        phase: 'processing',
        processed: 0,
        total: entries.length,
      });

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
          const corrupt = await this.is_blob_corrupt(ctx, entry);
          total_checked++;
          if (corrupt) failed_file_ids.push(entry.file_id);
        }
        processed++;
        emit_operation_progress(options, {
          operation: 'verify',
          workload: 'onedrive',
          phase: 'processing',
          processed,
          total: entries.length,
          current: entry.file_name,
        });
      }
      const interrupted = finish_operation_progress(
        options,
        'verify',
        'onedrive',
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
      const actual = await stream_sha256_from_storage(ctx, storage_key);
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
