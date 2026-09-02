import { timingSafeEqual } from 'node:crypto';
import { stream_sha256_from_storage } from '@wisecom/atlas-core/services/shared/stream-decrypt';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import type {
  TenantContext,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import type { DriveFileVersionIndexView, DriveManifestEntry, DriveWorkload } from '@/drive-ports';
import {
  load_drive_chain_entries,
  type DriveChainManifest,
  type DriveManifestLookup,
} from '@/shared/manifest-chain';

/** Both providers declare this shape; the shared flow builds it once. */
export interface DriveVerificationResult {
  readonly snapshot_id: string;
  readonly total_checked: number;
  readonly passed: number;
  readonly failed_file_ids: string[];
  readonly index_issues: string[];
  readonly interrupted: boolean;
}

/** What a provider supplies to the shared verification flow. */
export interface DriveVerifyDeps<TManifest extends DriveChainManifest> {
  readonly workload: DriveWorkload;
  readonly tenant_factory: TenantContextFactory;
  readonly manifests: DriveManifestLookup<TManifest>;
  /**
   * Version index rows for the owning segment of the resolved manifest. The segment is named
   * after what it owns in each provider, so the provider reads it off its own manifest.
   */
  readonly list_indexes: (
    ctx: TenantContext,
    manifest: TManifest,
  ) => Promise<readonly DriveFileVersionIndexView[]>;
}

/** Checks a snapshot's content blobs against manifest checksums, plus its per-file index rows. */
export async function verify_drive_snapshot<TManifest extends DriveChainManifest>(
  deps: DriveVerifyDeps<TManifest>,
  tenant_id: string,
  owner_id: string,
  snapshot_id: string,
  options: VerificationOptions = {},
): Promise<DriveVerificationResult> {
  const { workload } = deps;
  owner_id = normalize_owner_id(owner_id);
  if (begin_operation_progress(options, 'verify', workload)) {
    finish_operation_progress(options, 'verify', workload, 0, 0);
    return {
      snapshot_id,
      total_checked: 0,
      passed: 0,
      failed_file_ids: [],
      index_issues: [],
      interrupted: true,
    };
  }
  const ctx = await deps.tenant_factory.create_readonly(tenant_id);
  try {
    // The chain, not the single manifest: a snapshot inherits every file that last changed in an
    // earlier run, and verifying only the target would report those as checked when they were
    // never looked at (issue #173).
    const { manifest, entries } = await load_drive_chain_entries(
      deps.manifests,
      ctx,
      owner_id,
      snapshot_id,
    );

    const failed_file_ids: string[] = [];
    const index_issues: string[] = [];
    let total_checked = 0;
    let processed = 0;
    // One read of the owning segment's merged version index instead of one lookup per entry: the
    // index is a handful of per-run objects since issue #161.
    const indexes_by_file = new Map(
      (await deps.list_indexes(ctx, manifest)).map((idx) => [idx.file_id, idx]),
    );
    emit_operation_progress(options, {
      operation: 'verify',
      workload,
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

      if (entry_has_blob(entry)) {
        const corrupt = await is_blob_corrupt(ctx, entry);
        total_checked++;
        if (corrupt) failed_file_ids.push(entry.file_id);
      }
      processed++;
      emit_operation_progress(options, {
        operation: 'verify',
        workload,
        phase: 'processing',
        processed,
        total: entries.length,
        current: entry.file_name,
      });
    }
    const interrupted = finish_operation_progress(
      options,
      'verify',
      workload,
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

/** A tombstone and an entry with no stored blob have nothing to verify. */
function entry_has_blob(entry: DriveManifestEntry): boolean {
  return (
    entry.change_type !== 'deleted' &&
    entry.storage_key !== undefined &&
    entry.storage_key.length > 0 &&
    entry.checksum !== undefined &&
    entry.checksum.length > 0
  );
}

async function is_blob_corrupt(ctx: TenantContext, entry: DriveManifestEntry): Promise<boolean> {
  const storage_key = entry.storage_key;
  const expected = entry.checksum;
  if (!storage_key || !expected) return true;
  try {
    if (!(await ctx.storage.exists(storage_key))) return true;
    const actual = await stream_sha256_from_storage(ctx, storage_key);
    return is_checksum_mismatch(actual, expected);
  } catch {
    return true;
  }
}

function is_checksum_mismatch(actual_checksum: string, expected_checksum: string): boolean {
  if (actual_checksum.length !== expected_checksum.length) return true;
  const a = Buffer.from(actual_checksum, 'utf8');
  const b = Buffer.from(expected_checksum, 'utf8');
  return !timingSafeEqual(a, b);
}
