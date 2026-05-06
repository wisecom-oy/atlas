import { createHash } from 'node:crypto';
import type { TenantContext } from '@atlas/types';
import type { MailboxConnector, MailMessage } from '@atlas/types';
import type { ManifestEntry } from '@atlas/types';
import { fetch_and_store_attachments } from '@/services/backup/attachment-storage-sync';
import { calc_rate } from '@atlas/core/services/shared/progress-rate';
import type { BackupProgressReporter, ObjectLockPolicy } from '@atlas/types';

export interface FolderSyncResult {
  entries: ManifestEntry[];
  delta_link: string;
  stored: number;
  deduplicated: number;
  attachments_stored: number;
  folder_processed: number;
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
  prev_delta_link?: string;
  previous_manifest_entries?: number;
  page_size?: number;
  object_lock_policy?: ObjectLockPolicy;
}

const DEFAULT_ATTACHMENT_CONCURRENCY = 3;

interface PendingAttachment {
  entry_index: number;
  message_id: string;
}

/** Processes a single message: dedup check, encrypt, store. Returns index for deferred attachment fetch. */
async function process_message(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  message: MailMessage,
  entries: ManifestEntry[],
  stats: { stored: number; deduplicated: number; att_stored: number },
  pending_attachments: PendingAttachment[],
  object_lock_policy?: ObjectLockPolicy,
): Promise<void> {
  const entry = await store_single_message(ctx, message, owner_id, object_lock_policy);
  if (entry.was_new) stats.stored++;
  else stats.deduplicated++;

  const entry_index = entries.length;
  entries.push(entry.manifest_entry);

  if (message.has_attachments) {
    pending_attachments.push({ entry_index, message_id: message.message_id });
  }
}

/** Drains all pending attachment fetches in parallel batches of `concurrency`. */
async function flush_pending_attachments(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  entries: ManifestEntry[],
  stats: { stored: number; deduplicated: number; att_stored: number },
  pending: PendingAttachment[],
  object_lock_policy?: ObjectLockPolicy,
  concurrency = DEFAULT_ATTACHMENT_CONCURRENCY,
): Promise<void> {
  while (pending.length > 0) {
    const batch = pending.splice(0, concurrency);
    const tasks = batch.map(async (p) => {
      const att = await fetch_and_store_attachments(
        ctx,
        connector,
        tenant_id,
        owner_id,
        p.message_id,
        undefined,
        object_lock_policy,
      );
      if (att && att.length > 0) {
        stats.att_stored += att.length;
        entries[p.entry_index] = { ...entries[p.entry_index]!, attachments: att };
      }
    });

    await Promise.all(tasks);
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
    prev_delta_link,
    folder_total,
    page_size,
    object_lock_policy,
  } = params;
  const previous_manifest_entries = params.previous_manifest_entries ?? 0;

  const entries: ManifestEntry[] = [];
  const stats = { stored: 0, deduplicated: 0, att_stored: 0 };
  const pending_attachments: PendingAttachment[] = [];
  let folder_processed = 0;
  let streamed = false;
  const page_start = Date.now();

  const on_page = async (
    _page: number,
    total_items: number,
    page_messages: MailMessage[],
  ): Promise<boolean> => {
    streamed = true;

    if (is_hard_stopped()) return false;

    const elapsed_ms = Date.now() - page_start;
    const page_rate = calc_rate(total_items, elapsed_ms);
    const remaining = global_total - global_processed_before - total_items;
    const eta = page_rate > 0 ? remaining / page_rate : 0;
    progress.update_paging(folder_index, total_items, page_rate, eta);

    if (is_interrupted()) return true;

    for (const message of page_messages) {
      if (is_interrupted()) break;
      await process_message(
        ctx,
        connector,
        tenant_id,
        owner_id,
        message,
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
    }

    await flush_pending_attachments(
      ctx,
      connector,
      tenant_id,
      owner_id,
      entries,
      stats,
      pending_attachments,
      object_lock_policy,
    );

    return true;
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
    !is_interrupted() &&
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
    for (const message of delta.messages) {
      if (is_interrupted()) break;
      await process_message(
        ctx,
        connector,
        tenant_id,
        owner_id,
        message,
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
    }

    await flush_pending_attachments(
      ctx,
      connector,
      tenant_id,
      owner_id,
      entries,
      stats,
      pending_attachments,
      object_lock_policy,
    );
  }

  return {
    entries,
    delta_link: delta.delta_link,
    stored: stats.stored,
    deduplicated: stats.deduplicated,
    attachments_stored: stats.att_stored,
    folder_processed,
  };
}

/** Content-addressed storage with SHA-256 dedup: hash -> check exists -> encrypt -> upload. */
export async function store_single_message(
  ctx: TenantContext,
  message: MailMessage,
  owner_id: string,
  object_lock_policy?: ObjectLockPolicy,
): Promise<{ manifest_entry: ManifestEntry; was_new: boolean }> {
  const checksum = createHash('sha256').update(message.raw_body).digest('hex');
  const storage_key = `data/${owner_id}/${checksum}`;

  const already_stored = await ctx.storage.exists(storage_key);
  if (!already_stored) {
    const ciphertext = ctx.encrypt(message.raw_body);
    await ctx.storage.put(
      storage_key,
      ciphertext,
      {
        'x-message-id': message.message_id,
        'x-plaintext-sha256': checksum,
      },
      object_lock_policy,
    );
  }

  const manifest_entry: ManifestEntry = {
    object_id: message.message_id,
    storage_key,
    checksum,
    size_bytes: message.size_bytes,
    subject: message.subject,
    folder_id: message.folder_id,
  };

  return { manifest_entry, was_new: !already_stored };
}
