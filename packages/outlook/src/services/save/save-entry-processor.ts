import { mark_downloaded_from_internet } from '@wisecom/atlas-core/utils/zone-identifier';
import type { TenantContext } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import type { SaveResult } from '@wisecom/atlas-types';
import type { EntryResult } from '@/services/save/save-entry-writer';
import { save_json_entry, save_mime_entry } from '@/services/save/save-entry-writer';
import { verify_checksum } from '@/services/save/save-integrity-validator';
import type { ArchiveWriter } from '@/services/save/save-zip-writer';
import { create_save_archive, finalize_archive } from '@/services/save/save-zip-writer';
import type { OperationControlOptions, TransferProgressReporter } from '@wisecom/atlas-types';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';

/**
 * Processes all grouped entries into a zip archive, updating the dashboard.
 *
 * Each message is fully streamed to disk before the next one is fetched from
 * S3 (download → decrypt → verify → build EML → compress → flush). This
 * sequential-per-entry design keeps memory bounded to one message at a time,
 * which is critical for mailboxes that can reach hundreds of gigabytes.
 */
export async function save_entries_to_archive(
  ctx: TenantContext,
  output_path: string,
  skip_integrity: boolean,
  groups: Map<string, ManifestEntry[]>,
  folder_map: Map<string, string>,
  dashboard: TransferProgressReporter,
  is_interrupted: () => boolean,
  control: OperationControlOptions,
): Promise<Omit<SaveResult, 'snapshot_id'> & { processed: number }> {
  const { archive, promise } = create_save_archive(output_path);

  let global_saved = 0;
  let global_att = 0;
  let global_errors = 0;
  let global_processed = 0;
  const all_errors: string[] = [];
  const integrity_failures: string[] = [];
  let interrupted = false;
  const should_interrupt = (): boolean => {
    interrupted ||= is_interrupted();
    return interrupted;
  };
  const start = Date.now();
  const global_total = [...groups.values()].reduce((s, g) => s + g.length, 0);

  let folder_index = 0;
  for (const [fid, folder_items] of groups) {
    if (should_interrupt()) break;
    dashboard.mark_active(folder_index);

    const folder_name = folder_map.get(fid) ?? 'Unknown';
    const used_names = new Set<string>();

    const folder_result = await process_folder_entries(
      ctx,
      folder_items,
      folder_name,
      folder_index,
      skip_integrity,
      archive,
      used_names,
      groups,
      global_total,
      start,
      dashboard,
      should_interrupt,
      { all_errors, integrity_failures },
      control,
    );

    global_errors += folder_result.error_count;
    if (!should_interrupt()) {
      dashboard.mark_done(folder_index, folder_result.folder_saved, folder_result.folder_att);
    }

    global_saved += folder_result.folder_saved;
    global_att += folder_result.folder_att;
    global_processed += folder_result.folder_processed;
    folder_index++;
  }

  dashboard.show_finalizing();
  emit_operation_progress(control, {
    operation: 'save',
    workload: 'outlook',
    phase: 'finalizing',
    processed: global_processed,
    total: global_total,
  });
  await finalize_archive(archive);
  const total_bytes = await promise;
  await mark_downloaded_from_internet(output_path);

  log_save_summary(global_saved, global_att, global_errors, total_bytes, start);

  return {
    saved_count: global_saved,
    attachment_count: global_att,
    error_count: global_errors,
    errors: all_errors,
    output_path,
    total_bytes,
    integrity_failures,
    processed: global_processed,
    interrupted: should_interrupt(),
  };
}

interface FolderEntryCounters {
  all_errors: string[];
  integrity_failures: string[];
}

/** Processes all manifest entries in one folder, updating dashboard progress. */
async function process_folder_entries(
  ctx: TenantContext,
  folder_items: ManifestEntry[],
  folder_name: string,
  folder_index: number,
  skip_integrity: boolean,
  archive: ArchiveWriter,
  used_names: Set<string>,
  groups: Map<string, ManifestEntry[]>,
  global_total: number,
  start: number,
  dashboard: TransferProgressReporter,
  is_interrupted: () => boolean,
  counters: FolderEntryCounters,
  control: OperationControlOptions,
): Promise<{
  folder_saved: number;
  folder_att: number;
  error_count: number;
  folder_processed: number;
}> {
  let folder_saved = 0;
  let folder_processed = 0;
  let folder_att = 0;
  let integrity_ok = 0;
  let integrity_fail = 0;
  let error_count = 0;

  for (const entry of folder_items) {
    if (is_interrupted()) break;

    try {
      const result = await process_single_entry(
        ctx,
        entry,
        folder_name,
        skip_integrity,
        archive,
        used_names,
      );

      folder_saved++;
      folder_att += result.attachment_count;
      integrity_ok += result.integrity_ok;
      integrity_fail += result.integrity_fail;
      counters.integrity_failures.push(...result.integrity_failures);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      counters.all_errors.push(`${entry.object_id}: ${msg}`);
      error_count++;
    }

    folder_processed++;
    const gp = count_processed_before(groups, folder_index) + folder_processed;
    const rate = calc_rate(gp, Date.now() - start);
    const eta = rate > 0 ? (global_total - gp) / rate : 0;

    dashboard.update_active(folder_index, {
      transferred: folder_saved,
      attachments: folder_att,
      integrity_ok,
      integrity_fail,
      rate,
      eta_seconds: eta,
    });
    dashboard.update_total(gp, global_total, rate, eta);
    emit_operation_progress(control, {
      operation: 'save',
      workload: 'outlook',
      phase: 'processing',
      processed: gp,
      total: global_total,
      current: entry.subject ?? entry.object_id,
      rate,
    });
  }

  return { folder_saved, folder_processed, folder_att, error_count };
}

/** Decrypts one manifest entry, verifies it, and writes its .eml into the archive. */
async function process_single_entry(
  ctx: TenantContext,
  entry: ManifestEntry,
  folder_name: string,
  skip_integrity: boolean,
  archive: ArchiveWriter,
  used_names: Set<string>,
): Promise<EntryResult> {
  const result: EntryResult = {
    attachment_count: 0,
    integrity_ok: 0,
    integrity_fail: 0,
    integrity_failures: [],
  };

  const ciphertext = await ctx.storage.get(entry.storage_key);
  const plaintext = ctx.decrypt(ciphertext);

  if (!skip_integrity && entry.checksum) {
    if (!verify_checksum(plaintext, entry.checksum)) {
      result.integrity_fail++;
      result.integrity_failures.push(`message:${entry.object_id}`);
      logger.warn(`Integrity check failed for message ${entry.object_id}`);
    } else {
      result.integrity_ok++;
    }
  }

  if (entry.payload_format === 'mime') {
    await save_mime_entry(entry, folder_name, plaintext, archive, used_names);
  } else {
    await save_json_entry(
      ctx,
      entry,
      folder_name,
      plaintext,
      skip_integrity,
      archive,
      used_names,
      result,
    );
  }

  return result;
}

function count_processed_before(
  groups: Map<string, ManifestEntry[]>,
  folder_index: number,
): number {
  let count = 0;
  let i = 0;
  for (const [, items] of groups) {
    if (i >= folder_index) break;
    count += items.length;
    i++;
  }
  return count;
}

function log_save_summary(
  saved: number,
  attachments: number,
  errors: number,
  total_bytes: number,
  start: number,
): void {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const size_mb = (total_bytes / (1024 * 1024)).toFixed(1);
  logger.info(
    `${saved} saved, ${attachments} attachments, ${errors} errors, ${size_mb} MB -- ${elapsed}s`,
  );
}
