import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import {
  add_file_to_archive,
  create_file_archive,
  finalize_file_archive,
} from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import { mark_downloaded_from_internet } from '@wisecom/atlas-core/utils/zone-identifier';
import type {
  FileSaveOptions,
  FileSaveResult,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import type { DriveManifestEntry, DriveWorkload } from '@/drive-ports';
import { filter_drive_entries } from '@/shared/entry-filter';
import {
  load_drive_chain_entries,
  restorable_entries,
  type DriveChainManifest,
  type DriveManifestLookup,
} from '@/shared/manifest-chain';
import {
  should_stream_restore,
  stream_decrypt_from_storage,
  verify_streaming_checksum,
} from '@/restore/streaming-restore';

/** What a provider supplies to the shared save flow: its workload name and its manifest lookup. */
export interface DriveSaveDeps<TManifest extends DriveChainManifest> {
  readonly workload: DriveWorkload;
  readonly tenant_factory: TenantContextFactory;
  readonly manifests: DriveManifestLookup<TManifest>;
}

/**
 * Saves files from a drive snapshot to a local zip archive.
 *
 * The flow is provider-agnostic: resolve the snapshot chain, filter it, then decrypt and write
 * each entry, streaming the large ones. Both providers ran identical copies of it, so a fix such
 * as the checksum verification below had to be applied twice to hold.
 */
export async function save_drive_snapshot<TManifest extends DriveChainManifest>(
  deps: DriveSaveDeps<TManifest>,
  tenant_id: string,
  owner_id: string,
  options: FileSaveOptions,
): Promise<FileSaveResult> {
  const { workload } = deps;
  owner_id = normalize_owner_id(owner_id);
  if (begin_operation_progress(options, 'save', workload)) {
    finish_operation_progress(options, 'save', workload, 0, 0);
    return empty_save_result(options.snapshot_id, options.output_path ?? '', true);
  }
  const ctx = await deps.tenant_factory.create(tenant_id);
  try {
    const chain = await load_drive_chain_entries(
      deps.manifests,
      ctx,
      owner_id,
      options.snapshot_id,
    );
    const restorable = filter_drive_entries(restorable_entries(chain.entries), options.file_filter);

    if (restorable.length === 0) {
      const interrupted = finish_operation_progress(options, 'save', workload, 0, 0);
      return empty_save_result(options.snapshot_id, options.output_path ?? '', interrupted);
    }

    const output_path =
      options.output_path ?? build_default_output_path(workload, options.snapshot_id);
    const skip_integrity = options.skip_integrity_check ?? false;
    const { archive, promise } = create_file_archive(output_path);

    const integrity_failures: string[] = [];
    const { files_saved, files_skipped, errors } = await save_entries_to_archive(
      workload,
      ctx,
      archive,
      restorable,
      skip_integrity,
      integrity_failures,
      options,
    );

    emit_operation_progress(options, {
      operation: 'save',
      workload,
      phase: 'finalizing',
      processed: files_saved + files_skipped,
      total: restorable.length,
    });
    await finalize_file_archive(archive);
    const total_bytes = await promise;
    await mark_downloaded_from_internet(output_path);
    const interrupted =
      files_saved + files_skipped < restorable.length || options.should_interrupt?.() === true;
    emit_operation_progress(options, {
      operation: 'save',
      workload,
      phase: interrupted ? 'interrupted' : 'completed',
      processed: files_saved + files_skipped,
      total: restorable.length,
    });

    return {
      snapshot_id: options.snapshot_id,
      files_saved,
      files_skipped,
      errors,
      integrity_failures,
      output_path,
      total_bytes,
      interrupted,
    };
  } finally {
    ctx.destroy();
  }
}

/** Saves sequential entries until cancellation, reporting partial counts. */
async function save_entries_to_archive(
  workload: DriveWorkload,
  ctx: TenantContext,
  archive: Parameters<typeof add_file_to_archive>[0],
  entries: DriveManifestEntry[],
  skip_integrity: boolean,
  integrity_failures: string[],
  options: FileSaveOptions,
): Promise<{ files_saved: number; files_skipped: number; errors: string[] }> {
  let files_saved = 0;
  let files_skipped = 0;
  const errors: string[] = [];
  emit_operation_progress(options, {
    operation: 'save',
    workload,
    phase: 'processing',
    processed: 0,
    total: entries.length,
  });

  for (const entry of entries) {
    if (options.should_interrupt?.() === true) break;
    try {
      const content = await download_and_decrypt(ctx, entry, skip_integrity, integrity_failures);
      if (!content) {
        files_skipped++;
      } else {
        await add_file_to_archive(archive, entry.parent_path, entry.file_name, content);
        files_saved++;
        logger.info(`Saved: ${entry.parent_path}/${entry.file_name}`);
      }
    } catch (err) {
      errors.push(`${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`);
      files_skipped++;
    }
    emit_operation_progress(options, {
      operation: 'save',
      workload,
      phase: 'processing',
      processed: files_saved + files_skipped,
      total: entries.length,
      current: entry.file_name,
    });
  }

  return { files_saved, files_skipped, errors };
}

async function download_and_decrypt(
  ctx: TenantContext,
  entry: DriveManifestEntry,
  skip_integrity: boolean,
  integrity_failures: string[],
): Promise<Buffer | undefined> {
  if (!entry.storage_key) return undefined;

  if (should_stream_restore(entry)) {
    try {
      const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, entry.storage_key);
      if (!skip_integrity && !verify_streaming_checksum(entry, sha256_hex)) {
        integrity_failures.push(entry.file_id);
        return undefined;
      }
      return content;
    } catch (err) {
      logger.warn(
        `Streaming decrypt failed for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  return buffered_decrypt(ctx, entry, skip_integrity, integrity_failures);
}

async function buffered_decrypt(
  ctx: TenantContext,
  entry: DriveManifestEntry,
  skip_integrity: boolean,
  integrity_failures: string[],
): Promise<Buffer | undefined> {
  try {
    const ciphertext = await ctx.storage.get(entry.storage_key!);
    const content = ctx.decrypt(ciphertext);
    if (!skip_integrity && entry.checksum) {
      if (!sha256_matches(content, entry.checksum)) {
        integrity_failures.push(entry.file_id);
        logger.warn(`Checksum mismatch for ${entry.file_name}; skipping`);
        return undefined;
      }
    }
    return content;
  } catch (err) {
    logger.warn(
      `Failed to decrypt ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** A result with no files, used for a pre-aborted run and for a snapshot with nothing to save. */
function empty_save_result(
  snapshot_id: string,
  output_path: string,
  interrupted = false,
): FileSaveResult {
  return {
    snapshot_id,
    files_saved: 0,
    files_skipped: 0,
    errors: [],
    integrity_failures: [],
    output_path,
    total_bytes: 0,
    interrupted,
  };
}

function sha256_matches(content: Buffer, expected: string): boolean {
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

function build_default_output_path(prefix: string, snapshot_id: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${snapshot_id}-${ts}.zip`;
}
