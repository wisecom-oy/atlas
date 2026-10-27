import type { ExtendedProperty, TenantContext } from '@wisecom/atlas-types';
import {
  capture_mime_payload,
  capture_page_reactions,
  store_single_message,
} from '@/services/backup/message-payload-store';
import type { MailboxConnector, MailMessage } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import {
  flush_pending_attachments,
  type PendingAttachment,
} from '@/services/backup/attachment-storage-sync';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import type {
  BackupProgressReporter,
  ObjectLockPolicy,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';

export interface FolderSyncResult {
  entries: ManifestEntry[];
  delta_link: string;
  /** Message IDs the delta reported as deleted or moved out of this folder. */
  removed_ids: string[];
  /** True only when every page of the folder was fully processed; the delta link MUST NOT be persisted otherwise. */
  complete: boolean;
  stored: number;
  deduplicated: number;
  attachments_stored: number;
  /**
   * Messages whose attachments could not be fetched, one line each.
   *
   * A folder-level error would discard the folder's other entries, and their blobs are already
   * in storage, so they would be orphans until a later run deduplicated them (issue #366).
   */
  attachment_errors: string[];
  folder_processed: number;
  /** Per-folder problems that lost data but no message, e.g. reactions not read (issue #513). */
  warnings: string[];
  /** Messages stored without their reactions; also summarised in `warnings`. */
  reactions_not_captured: number;
}

export interface FolderSyncParams {
  ctx: TenantContext;
  connector: MailboxConnector;
  tenant_id: string;
  owner_id: string;
  folder_id: string;
  folder_index: number;
  folder_total: number;
  global_total: number;
  global_processed_before: number;
  sync_start: number;
  progress: BackupProgressReporter;
  is_interrupted: () => boolean;
  is_hard_stopped: () => boolean;
  operation_control: OperationControlOptions;
  prev_delta_link?: string;
  previous_manifest_entries?: number;
  page_size?: number;
  object_lock_policy?: ObjectLockPolicy;
}

/**
 * Processes a single message: capture MIME, dedup check, encrypt, store.
 * MIME embeds its attachments, so only a JSON fallback queues a separate
 * attachment fetch. Reactions were read for the whole page beforehand (issue #513).
 */
async function process_message(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  message: MailMessage,
  reactions: ExtendedProperty[],
  entries: ManifestEntry[],
  stats: { stored: number; deduplicated: number; att_stored: number },
  pending_attachments: PendingAttachment[],
  object_lock_policy?: ObjectLockPolicy,
): Promise<void> {
  const mime = await capture_mime_payload(connector, tenant_id, owner_id, message);
  const entry = await store_single_message(
    ctx,
    message,
    owner_id,
    object_lock_policy,
    mime,
    reactions,
  );
  if (entry.was_new) stats.stored++;
  else stats.deduplicated++;

  const entry_index = entries.length;
  entries.push(entry.manifest_entry);

  if (!mime && message.has_attachments) {
    pending_attachments.push({ entry_index, message_id: message.message_id });
  }
}

/** Runs a delta sync for one folder, processing messages inline as pages arrive. */
export async function sync_single_folder(params: FolderSyncParams): Promise<FolderSyncResult> {
  const {
    ctx,
    connector,
    tenant_id,
    owner_id,
    folder_id,
    folder_index,
    global_total,
    global_processed_before,
    sync_start,
    progress,
    is_interrupted,
    is_hard_stopped,
    operation_control,
    prev_delta_link,
    folder_total,
    page_size,
    object_lock_policy,
  } = params;
  const previous_manifest_entries = params.previous_manifest_entries ?? 0;

  const entries: ManifestEntry[] = [];
  const stats = { stored: 0, deduplicated: 0, att_stored: 0, reactions_failed: 0 };
  const pending_attachments: PendingAttachment[] = [];
  const attachment_errors: string[] = [];
  let folder_processed = 0;
  let streamed = false;
  // Set whenever any page or message is skipped; blocks delta-link persistence (issue #23).
  let aborted = false;
  const page_start = Date.now();

  const on_page = async (
    _page: number,
    total_items: number,
    page_messages: MailMessage[],
  ): Promise<boolean> => {
    streamed = true;

    if (is_hard_stopped()) {
      aborted = true;
      return false;
    }

    const elapsed_ms = Date.now() - page_start;
    const page_rate = calc_rate(total_items, elapsed_ms);
    const remaining = global_total - global_processed_before - total_items;
    const eta = page_rate > 0 ? remaining / page_rate : 0;
    progress.update_paging(folder_index, total_items, page_rate, eta);

    if (is_interrupted()) {
      aborted = true;
      return false;
    }

    // Read for the page, not per message: reactions belong to the manifest entry, so a message
    // whose content dedups still needs them, and the batch costs one round trip per 20.
    const reactions = await capture_page_reactions(connector, tenant_id, owner_id, page_messages);
    stats.reactions_failed += reactions.failed;
    for (const message of page_messages) {
      if (is_interrupted()) {
        aborted = true;
        break;
      }
      await process_message(
        ctx,
        connector,
        tenant_id,
        owner_id,
        message,
        reactions.by_message.get(message.message_id) ?? [],
        entries,
        stats,
        pending_attachments,
        object_lock_policy,
      );
      folder_processed++;
      const gp = global_processed_before + folder_processed;
      const rate = calc_rate(gp, Date.now() - sync_start);
      const msg_eta = rate > 0 ? (global_total - gp) / rate : 0;
      progress.update_total(gp, global_total, rate, msg_eta);
      progress.update_active(folder_index, folder_processed, rate, msg_eta);
      emit_operation_progress(operation_control, {
        operation: 'backup',
        workload: 'outlook',
        phase: 'processing',
        processed: gp,
        total: global_total,
        current: message.subject ?? message.message_id,
        rate,
      });
    }

    const drained = await flush_pending_attachments(
      ctx,
      connector,
      tenant_id,
      owner_id,
      entries,
      stats,
      pending_attachments,
      attachment_errors,
      is_interrupted,
      object_lock_policy,
    );
    if (!drained) aborted = true;

    return !aborted;
  };

  let delta = await connector.fetch_delta(
    tenant_id,
    owner_id,
    folder_id,
    prev_delta_link,
    on_page,
    page_size,
  );

  if (
    !aborted &&
    prev_delta_link &&
    folder_processed === 0 &&
    folder_total > 0 &&
    previous_manifest_entries === 0
  ) {
    delta = await connector.fetch_delta(
      tenant_id,
      owner_id,
      folder_id,
      undefined,
      on_page,
      page_size,
    );
  }

  if (!streamed) {
    const reactions = await capture_page_reactions(connector, tenant_id, owner_id, delta.messages);
    stats.reactions_failed += reactions.failed;
    for (const message of delta.messages) {
      if (is_interrupted()) {
        aborted = true;
        break;
      }
      await process_message(
        ctx,
        connector,
        tenant_id,
        owner_id,
        message,
        reactions.by_message.get(message.message_id) ?? [],
        entries,
        stats,
        pending_attachments,
        object_lock_policy,
      );
      folder_processed++;
      const gp = global_processed_before + folder_processed;
      const rate = calc_rate(gp, Date.now() - sync_start);
      const eta = rate > 0 ? (global_total - gp) / rate : 0;
      progress.update_total(gp, global_total, rate, eta);
      progress.update_active(folder_index, folder_processed, rate, eta);
      emit_operation_progress(operation_control, {
        operation: 'backup',
        workload: 'outlook',
        phase: 'processing',
        processed: gp,
        total: global_total,
        current: message.subject ?? message.message_id,
        rate,
      });
    }

    const drained = await flush_pending_attachments(
      ctx,
      connector,
      tenant_id,
      owner_id,
      entries,
      stats,
      pending_attachments,
      attachment_errors,
      is_interrupted,
      object_lock_policy,
    );
    if (!drained) aborted = true;
  }

  return {
    entries,
    delta_link: delta.delta_link,
    removed_ids: delta.removed_ids,
    complete: !aborted,
    stored: stats.stored,
    deduplicated: stats.deduplicated,
    attachments_stored: stats.att_stored,
    attachment_errors,
    folder_processed,
    warnings:
      stats.reactions_failed > 0
        ? [
            `reactions not captured for ${stats.reactions_failed} message(s); they are read again only when the message changes`,
          ]
        : [],
    reactions_not_captured: stats.reactions_failed,
  };
}
