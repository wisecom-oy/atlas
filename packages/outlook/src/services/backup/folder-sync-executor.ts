import type { TenantContext } from '@wisecom/atlas-types';
import { capture_page_extended_properties } from '@/services/backup/message-payload-store';
import { process_message } from '@/services/backup/folder-message-processor';
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
  /**
   * True only when every page of the folder was fully processed and every message in it was
   * captured in full; the delta link MUST NOT be persisted otherwise.
   */
  complete: boolean;
  stored: number;
  deduplicated: number;
  attachments_stored: number;
  /**
   * Messages stored without their original MIME or their attachments, one line each. Any line
   * leaves the folder incomplete, so its delta link is withheld and the next run presents those
   * messages again (issues #614, #615).
   *
   * A folder-level error would discard the folder's other entries, and their blobs are already
   * in storage, so they would be orphans until a later run deduplicated them (issue #366).
   */
  message_errors: string[];
  folder_processed: number;
  /**
   * Per-folder problems that lost data but no message, e.g. reactions not read (issue #513) or MIME
   * Exchange will never produce (issue #812). None of them withholds the delta link.
   */
  warnings: string[];
  /** Messages stored without their reactions and pin; also summarised in `warnings`. */
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
  const message_errors: string[] = [];
  const message_warnings: string[] = [];
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

    // Read for the page, not per message: reactions and pin belong to the manifest entry, so a message
    // whose content dedups still needs them, and the batch costs one round trip per 20.
    const properties = await capture_page_extended_properties(
      connector,
      tenant_id,
      owner_id,
      page_messages,
    );
    stats.reactions_failed += properties.failed;
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
        properties.by_message.get(message.message_id),
        entries,
        stats,
        pending_attachments,
        message_errors,
        message_warnings,
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
      message_errors,
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
    const properties = await capture_page_extended_properties(
      connector,
      tenant_id,
      owner_id,
      delta.messages,
    );
    stats.reactions_failed += properties.failed;
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
        properties.by_message.get(message.message_id),
        entries,
        stats,
        pending_attachments,
        message_errors,
        message_warnings,
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
      message_errors,
      is_interrupted,
      object_lock_policy,
    );
    if (!drained) aborted = true;
  }

  return {
    entries,
    delta_link: delta.delta_link,
    removed_ids: delta.removed_ids,
    // A message stored without its MIME or attachments is not presented again by a delta link
    // that moved past it, so a failure holds the link back like an interrupt does.
    complete: !aborted && message_errors.length === 0,
    stored: stats.stored,
    deduplicated: stats.deduplicated,
    attachments_stored: stats.att_stored,
    message_errors,
    folder_processed,
    warnings: [
      ...message_warnings,
      ...(stats.reactions_failed > 0
        ? [
            `reactions and pin not captured for ${stats.reactions_failed} message(s); they are read again only when the message changes`,
          ]
        : []),
    ],
    reactions_not_captured: stats.reactions_failed,
  };
}
