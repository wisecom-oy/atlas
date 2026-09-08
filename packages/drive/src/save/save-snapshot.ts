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
import {
  resolve_save_target,
  settle_empty_save_target,
  settle_failed_save_target,
} from '@wisecom/atlas-core/services/shared/save-archive-target';
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
  // Resolved up front so a conflicting options pair is refused before the caller's stream is
  // touched. The empty results below report no path at all: no archive was opened.
  const { target, output_path: resolved_output_path } = resolve_save_target(options, () =>
    build_default_output_path(workload, options.snapshot_id),
  );

  try {
    if (begin_operation_progress(options, 'save', workload)) {
      finish_operation_progress(options, 'save', workload, 0, 0);
      await settle_empty_save_target(target, true);
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
      const restorable = filter_drive_entries(
        restorable_entries(chain.entries),
        options.file_filter,
      );

      if (restorable.length === 0) {
        const interrupted = finish_operation_progress(options, 'save', workload, 0, 0);
        await settle_empty_save_target(target, interrupted);
        return empty_save_result(options.snapshot_id, options.output_path ?? '', interrupted);
      }

      return await write_drive_snapshot_to_archive(
        workload,
        ctx,
        target,
        resolved_output_path,
        restorable,
        options,
      );
    } finally {
      ctx.destroy();
    }
  } catch (err) {
    settle_failed_save_target(target);
    throw err;
  }
}

/** Writes snapshot entries to an archive and publishes the result. */
async function write_drive_snapshot_to_archive(
  workload: DriveWorkload,
  ctx: TenantContext,
  target: Parameters<typeof create_file_archive>[0],
  output_path: string,
  entries: DriveManifestEntry[],
  options: FileSaveOptions,
): Promise<FileSaveResult> {
  const skip_integrity = options.skip_integrity_check ?? false;
  const { archive, promise, publish, abort } = create_file_archive(target);

  try {
    const integrity_failures: string[] = [];
    const { files_saved, files_skipped, errors } = await save_entries_to_archive(
      workload,
      ctx,
      archive,
      entries,
      skip_integrity,
      integrity_failures,
      options,
    );

    emit_operation_progress(options, {
      operation: 'save',
      workload,
      phase: 'finalizing',
      processed: files_saved + files_skipped,
      total: entries.length,
    });
    const interrupted =
      files_saved + files_skipped < entries.length || options.should_interrupt?.() === true;
    let total_bytes: number;
    if (interrupted && typeof target !== 'string') {
      total_bytes = archive.pointer();
      await abort();
    } else {
      await finalize_file_archive(archive);
      total_bytes = await promise;
      // Only now does anything appear at the output path, so a failure above cannot leave a
      // truncated zip there and cannot destroy a file that was already sitting on it.
      await publish();
      // Mark only applies to a path target; a stream target has no local file.
      if (output_path !== '') {
        await mark_downloaded_from_internet(output_path);
      }
    }
    emit_operation_progress(options, {
      operation: 'save',
      workload,
      phase: interrupted ? 'interrupted' : 'completed',
      processed: files_saved + files_skipped,
      total: entries.length,
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
  } catch (err) {
    // Anything between opening the archive and publishing it can throw: the entry loop, the
    // finalize, the byte count, the move itself. None of them may leave a partial file behind
    // (issue #307).
    await abort();
    throw err;
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
      // A read or decrypt that threw is a damaged file, not a deliberate skip. It counts in both
      // places: `errors` so the run cannot exit clean, and `integrity_failures` so it is not
      // confused with an entry that had nothing to save (issue #341).
      errors.push(`${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`);
      integrity_failures.push(entry.file_id);
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
    const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, entry.storage_key);
    if (!skip_integrity && !verify_streaming_checksum(entry, sha256_hex)) {
      integrity_failures.push(entry.file_id);
      return undefined;
    }
    return content;
  }

  return buffered_decrypt(ctx, entry, skip_integrity, integrity_failures);
}

async function buffered_decrypt(
  ctx: TenantContext,
  entry: DriveManifestEntry,
  skip_integrity: boolean,
  integrity_failures: string[],
): Promise<Buffer | undefined> {
  const ciphertext = await ctx.storage.get(entry.storage_key!);
  const content = ctx.decrypt(ciphertext);
  // A missing checksum is not a pass. The streaming path already refuses it, and an entry nobody
  // can verify is exactly the one a substituted blob hides behind, so it is an integrity failure
  // rather than a file written into the archive unchecked (issues #340, #341).
  if (!skip_integrity && (!entry.checksum || !sha256_matches(content, entry.checksum))) {
    integrity_failures.push(entry.file_id);
    logger.warn(`Missing or mismatched checksum for ${entry.file_name}; skipping`);
    return undefined;
  }
  return content;
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
