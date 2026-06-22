import chalk from 'chalk';
import type { TenantContext } from '@atlas/types';
import type { MailboxConnector } from '@atlas/types';
import type { RestoreConnector } from '@atlas/types';
import type { ManifestEntry } from '@atlas/types';
import type { RestoreResult } from '@atlas/types';
import {
  decrypt_and_parse_message,
  sanitize_message_for_restore,
  extract_folder_id_from_json,
} from '@/services/restore/restore-message-transformer';
import { restore_entry_attachments } from '@/services/restore/restore-attachment-writer';
import {
  build_folder_map,
  create_restore_root,
  ensure_subfolder,
} from '@/services/restore/folder-restore-planner';
import type { RestoreProgressDashboard } from '@/services/restore/restore-progress-dashboard';
import { calc_rate } from '@atlas/core/services/shared/progress-rate';
import { logger } from '@atlas/core/utils/logger';

/** Decrypts, sanitizes, creates one message via Graph, then uploads attachments. */
export async function restore_one_entry(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  target_folder_id: string,
  entry: ManifestEntry,
): Promise<{ att: number }> {
  const json = await decrypt_and_parse_message(ctx, entry);
  const sanitized = sanitize_message_for_restore(json);
  const new_msg_id = await restore_connector.create_message(
    tenant_id,
    owner_id,
    target_folder_id,
    sanitized,
  );

  let att = 0;
  if (entry.attachments && entry.attachments.length > 0) {
    const result = await restore_entry_attachments(
      ctx,
      restore_connector,
      tenant_id,
      owner_id,
      new_msg_id,
      entry.attachments,
    );
    att = result.restored;
  }

  return { att };
}

/** Restores all entries for a single folder, updating dashboard per-message. */
export async function restore_folder_entries(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  target_folder_id: string,
  entries: ManifestEntry[],
  folder_index: number,
  global_before: number,
  global_total: number,
  start: number,
  dashboard: RestoreProgressDashboard,
  is_interrupted: () => boolean,
): Promise<{ restored: number; attachments: number; errors: string[] }> {
  let restored = 0;
  let attachments = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    if (is_interrupted()) break;

    try {
      const { att } = await restore_one_entry(
        ctx,
        restore_connector,
        tenant_id,
        owner_id,
        target_folder_id,
        entry,
      );
      restored++;
      attachments += att;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${entry.object_id}: ${msg}`);
    }

    const gp = global_before + restored;
    const rate = calc_rate(gp, Date.now() - start);
    const eta = rate > 0 ? (global_total - gp) / rate : 0;
    dashboard.update_active(folder_index, restored, restored, attachments, rate, eta);
    dashboard.update_total(gp, global_total, rate, eta);
  }

  return { restored, attachments, errors };
}

/** Restores a single message with its attachments. No dashboard needed. */
export async function restore_single_message(
  ctx: TenantContext,
  connector: MailboxConnector,
  restore_connector: RestoreConnector,
  tenant_id: string,
  source_mailbox: string,
  target_mailbox: string,
  snapshot_id: string,
  entry: ManifestEntry,
): Promise<RestoreResult> {
  const root = await create_restore_root(restore_connector, tenant_id, target_mailbox);
  const message_json = await decrypt_and_parse_message(ctx, entry);
  const folder_id = entry.folder_id ?? extract_folder_id_from_json(message_json);

  const folder_map = await build_folder_map(connector, tenant_id, source_mailbox);
  const created_folders = new Map<string, string>();
  const target_fid = await ensure_subfolder(
    restore_connector,
    tenant_id,
    target_mailbox,
    root.folder_id,
    folder_id,
    folder_map,
    created_folders,
  );

  const sanitized = sanitize_message_for_restore(message_json);
  const new_msg_id = await restore_connector.create_message(
    tenant_id,
    target_mailbox,
    target_fid,
    sanitized,
  );

  let att_count = 0;
  if (entry.attachments && entry.attachments.length > 0) {
    const att_result = await restore_entry_attachments(
      ctx,
      restore_connector,
      tenant_id,
      target_mailbox,
      new_msg_id,
      entry.attachments,
    );
    att_count = att_result.restored;
  }

  logger.success(`Restored 1 message${att_count > 0 ? ` + ${att_count} attachments` : ''}`);
  return {
    snapshot_id,
    restored_count: 1,
    attachment_count: att_count,
    error_count: 0,
    attachment_error_count: 0,
    errors: [],
    verification_warnings: [],
    restore_folder_name: root.display_name,
  };
}

/** Backfills folder_id for legacy manifest entries by decrypting message JSON. */
export async function backfill_missing_folder_ids(
  ctx: TenantContext,
  entries: ManifestEntry[],
): Promise<void> {
  const missing = entries.filter((e) => !e.folder_id);
  if (missing.length === 0) return;

  logger.info(`Backfilling folder_id for ${missing.length} legacy entries...`);
  for (const entry of missing) {
    const json = await decrypt_and_parse_message(ctx, entry);
    const fid = extract_folder_id_from_json(json);
    (entry as { folder_id?: string }).folder_id = fid;
  }
}

/** Logs a human-readable summary line after a batch restore completes. */
export function log_restore_summary(
  restored: number,
  attachments: number,
  errors: number,
  start: number,
): void {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(
    `${chalk.green(String(restored))} restored, ` +
      `${chalk.cyan(String(attachments))} attachments, ` +
      `${chalk.red(String(errors))} errors -- ${elapsed}s`,
  );
}
