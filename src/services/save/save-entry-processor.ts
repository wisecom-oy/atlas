import chalk from 'chalk';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { ManifestEntry, AttachmentEntry } from '@/domain/manifest';
import type { SaveResult } from '@/ports/save/use-case.port';
import { build_eml, build_eml_filename, deduplicate_filename } from '@/services/save/eml-builder';
import { verify_checksum } from '@/services/save/save-integrity-validator';
import {
  create_save_archive,
  add_eml_to_archive,
  finalize_archive,
} from '@/services/save/save-zip-writer';
import type { SaveProgressDashboard } from '@/services/save/save-progress-dashboard';
import { calc_rate } from '@/services/shared/progress-rate';
import { logger } from '@/utils/logger';

interface DecryptedAttachment {
  readonly name: string;
  readonly content_type: string;
  readonly content: Buffer;
  readonly is_inline: boolean;
  readonly content_id?: string;
}

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
  dashboard: SaveProgressDashboard,
  is_interrupted: () => boolean,
): Promise<Omit<SaveResult, 'snapshot_id'>> {
  const { archive, promise } = create_save_archive(output_path);

  let global_saved = 0;
  let global_att = 0;
  let global_errors = 0;
  let integrity_ok = 0;
  let integrity_fail = 0;
  const all_errors: string[] = [];
  const integrity_failures: string[] = [];
  const start = Date.now();
  const global_total = [...groups.values()].reduce((s, g) => s + g.length, 0);

  let folder_index = 0;
  for (const [fid, folder_items] of groups) {
    if (is_interrupted()) break;
    dashboard.mark_active(folder_index);

    const folder_name = folder_map.get(fid) ?? 'Unknown';
    const used_names = new Set<string>();
    let folder_saved = 0;
    let folder_processed = 0;
    let folder_att = 0;

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
        integrity_failures.push(...result.integrity_failures);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        all_errors.push(`${entry.object_id}: ${msg}`);
        global_errors++;
      }

      folder_processed++;
      const gp = count_processed_before(groups, folder_index) + folder_processed;
      const rate = calc_rate(gp, Date.now() - start);
      const eta = rate > 0 ? (global_total - gp) / rate : 0;

      dashboard.update_active(
        folder_index,
        folder_saved,
        folder_att,
        integrity_ok,
        integrity_fail,
        rate,
        eta,
      );
      dashboard.update_total(gp, global_total, rate, eta);
    }

    if (!is_interrupted()) {
      dashboard.mark_done(folder_index, folder_saved, folder_att);
    }

    global_saved += folder_saved;
    global_att += folder_att;
    folder_index++;
  }

  dashboard.show_finalizing();
  await finalize_archive(archive);
  const total_bytes = await promise;

  log_save_summary(global_saved, global_att, global_errors, total_bytes, start);

  return {
    saved_count: global_saved,
    attachment_count: global_att,
    error_count: global_errors,
    errors: all_errors,
    output_path,
    total_bytes,
    integrity_failures,
  };
}

interface EntryResult {
  attachment_count: number;
  integrity_ok: number;
  integrity_fail: number;
  integrity_failures: string[];
}

async function process_single_entry(
  ctx: TenantContext,
  entry: ManifestEntry,
  folder_name: string,
  skip_integrity: boolean,
  archive: Parameters<typeof add_eml_to_archive>[0],
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

  const message_json = JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>;
  const attachments = await decrypt_entry_attachments(ctx, entry, skip_integrity, result);

  const eml_buffer = build_eml(message_json, attachments);
  const received = message_json['receivedDateTime'] as string | undefined;
  const subject = message_json['subject'] as string | undefined;
  const raw_filename = build_eml_filename(received, subject);
  const filename = deduplicate_filename(raw_filename, used_names);

  await add_eml_to_archive(archive, folder_name, filename, eml_buffer);
  result.attachment_count = attachments.length;

  return result;
}

async function decrypt_entry_attachments(
  ctx: TenantContext,
  entry: ManifestEntry,
  skip_integrity: boolean,
  result: EntryResult,
): Promise<DecryptedAttachment[]> {
  if (!entry.attachments || entry.attachments.length === 0) return [];

  const decrypted: DecryptedAttachment[] = [];

  for (const att of entry.attachments) {
    if (!att.storage_key) continue;

    try {
      const content = await decrypt_and_verify_attachment(ctx, att, skip_integrity, result);
      decrypted.push({
        name: att.name,
        content_type: att.content_type,
        content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });
    } catch (err) {
      logger.warn(
        `Failed to decrypt attachment "${att.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return decrypted;
}

async function decrypt_and_verify_attachment(
  ctx: TenantContext,
  att: AttachmentEntry,
  skip_integrity: boolean,
  result: EntryResult,
): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(att.storage_key);
  const plaintext = ctx.decrypt(ciphertext);

  if (!skip_integrity && att.checksum) {
    if (!verify_checksum(plaintext, att.checksum)) {
      result.integrity_fail++;
      result.integrity_failures.push(`attachment:${att.attachment_id}`);
      logger.warn(`Integrity check failed for attachment "${att.name}"`);
    } else {
      result.integrity_ok++;
    }
  }

  return plaintext;
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
    `${chalk.green(String(saved))} saved, ` +
      `${chalk.cyan(String(attachments))} attachments, ` +
      `${chalk.red(String(errors))} errors, ` +
      `${chalk.cyan(size_mb + ' MB')} -- ${elapsed}s`,
  );
}
