import type { TenantContext } from '@wisecom/atlas-types';
import type { MailboxConnector } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import type { RestoreResult } from '@wisecom/atlas-types';
import {
  decrypt_and_parse_message,
  decrypt_and_parse_mime,
  sanitize_message_for_restore,
  build_restore_payload_from_mime,
  extract_folder_id_from_json,
} from '@/services/restore/restore-message-transformer';
import {
  restore_entry_attachments,
  restore_parsed_attachments,
} from '@/services/restore/restore-attachment-writer';
import {
  build_folder_map,
  create_restore_root,
  ensure_subfolder,
} from '@/services/restore/folder-restore-planner';
import type { OperationControlOptions, TransferProgressReporter } from '@wisecom/atlas-types';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';

/** Creates one message via Graph from its stored payload, then uploads attachments. */
export async function restore_one_entry(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  target_folder_id: string,
  entry: ManifestEntry,
): Promise<{ att: number }> {
  if (entry.payload_format === 'mime') {
    return restore_mime_entry(ctx, restore_connector, tenant_id, owner_id, target_folder_id, entry);
  }
  return restore_json_entry(ctx, restore_connector, tenant_id, owner_id, target_folder_id, entry);
}

/** Restores a legacy Graph JSON entry, pulling attachments back from storage. */
async function restore_json_entry(
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

/**
 * Restores a MIME entry by parsing the stored RFC 5322 bytes and feeding the
 * normal JSON create path. Graph's MIME import is not used: imported messages
 * are always drafts and the flag cannot be cleared. Attachments are embedded
 * in the blob, so they come from the parse rather than from storage.
 */
async function restore_mime_entry(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  target_folder_id: string,
  entry: ManifestEntry,
): Promise<{ att: number }> {
  const parsed = await decrypt_and_parse_mime(ctx, entry);
  const new_msg_id = await restore_connector.create_message(
    tenant_id,
    owner_id,
    target_folder_id,
    build_restore_payload_from_mime(parsed),
  );

  if (parsed.attachments.length === 0) return { att: 0 };

  const result = await restore_parsed_attachments(
    restore_connector,
    tenant_id,
    owner_id,
    new_msg_id,
    parsed.attachments,
  );
  return { att: result.restored };
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
  dashboard: TransferProgressReporter,
  is_interrupted: () => boolean,
  control: OperationControlOptions,
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
    dashboard.update_active(folder_index, {
      transferred: restored,
      attachments,
      rate,
      eta_seconds: eta,
    });
    dashboard.update_total(gp, global_total, rate, eta);
    emit_operation_progress(control, {
      operation: 'restore',
      workload: 'outlook',
      phase: 'processing',
      processed: gp,
      total: global_total,
      current: entry.subject ?? entry.object_id,
      rate,
    });
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
  const folder_id = await resolve_source_folder_id(ctx, entry);

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

  const { att: att_count } = await restore_one_entry(
    ctx,
    restore_connector,
    tenant_id,
    target_mailbox,
    target_fid,
    entry,
  );

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
    interrupted: false,
  };
}

/**
 * Resolves the source folder of an entry. MIME entries always carry
 * `folder_id` from backup; only legacy JSON manifests need the payload
 * decrypted to recover `parentFolderId`.
 */
async function resolve_source_folder_id(ctx: TenantContext, entry: ManifestEntry): Promise<string> {
  if (entry.folder_id) return entry.folder_id;
  if (entry.payload_format === 'mime') return '__unknown__';
  return extract_folder_id_from_json(await decrypt_and_parse_message(ctx, entry));
}

/**
 * Backfills `folder_id` on legacy manifest entries so a folder filter can match them.
 *
 * MIME entries are left alone. They hold raw RFC 822 bytes, so decrypting one and parsing it as
 * JSON throws, and because this runs before any per-entry error handling a single such entry took
 * the whole restore or export with it (issue #205). RFC 822 records no folder, so there is nothing
 * cheap to recover: they stay unresolved, and `filter_entries_by_folder_name` already drops entries
 * without a `folder_id`.
 */
export async function backfill_missing_folder_ids(
  ctx: TenantContext,
  entries: ManifestEntry[],
): Promise<void> {
  const missing = entries.filter((e) => !e.folder_id);
  if (missing.length === 0) return;

  const json_entries = missing.filter((e) => e.payload_format !== 'mime');
  const mime_count = missing.length - json_entries.length;
  if (mime_count > 0) {
    logger.warn(
      `${mime_count} legacy MIME ${mime_count === 1 ? 'entry carries' : 'entries carry'} no ` +
        'folder_id, so a folder filter cannot match them: RFC 822 does not record the source folder.',
    );
  }
  if (json_entries.length === 0) return;

  logger.info(`Backfilling folder_id for ${json_entries.length} legacy entries...`);
  for (const entry of json_entries) {
    // ManifestEntry types folder_id readonly and this backfill fills it in place, so the write
    // needs a mutable view of that one field.
    const writable: { folder_id?: string } = entry;
    try {
      const json = await decrypt_and_parse_message(ctx, entry);
      writable.folder_id = extract_folder_id_from_json(json);
    } catch (err) {
      // One unreadable payload must not abort a run that can still handle every other entry.
      logger.warn(
        `Could not recover folder_id for ${entry.object_id}, excluding it from the folder ` +
          `filter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  logger.info(`${restored} restored, ${attachments} attachments, ${errors} errors -- ${elapsed}s`);
}
