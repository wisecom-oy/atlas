import type { TenantContext } from '@wisecom/atlas-types';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { MailboxConnector, ManifestEntry, MessageAttachment } from '@wisecom/atlas-types';
import type { AttachmentEntry } from '@wisecom/atlas-types';
import type { ObjectLockPolicy } from '@wisecom/atlas-types';

/** Invoked after each attachment is stored: (done_so_far, total_attachments). */
export type AttachmentProgressCallback = (done: number, total: number) => void;

/**
 * Fetches attachments for a message via the connector and stores each one
 * using content-addressed keys under attachments/{owner_id}/{keyed content name}.
 * The optional on_progress callback fires after each attachment is processed.
 */
export async function fetch_and_store_attachments(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  message_id: string,
  on_progress?: AttachmentProgressCallback,
  object_lock_policy?: ObjectLockPolicy,
): Promise<AttachmentEntry[]> {
  const raw = await connector.fetch_attachments(tenant_id, owner_id, message_id);
  const entries: AttachmentEntry[] = [];

  for (let i = 0; i < raw.length; i++) {
    entries.push(await store_single_attachment(ctx, raw[i]!, owner_id, object_lock_policy));
    on_progress?.(i + 1, raw.length);
  }
  return entries;
}

/** Content-addressed storage for a single attachment, same dedup pattern as messages. */
async function store_single_attachment(
  ctx: TenantContext,
  att: MessageAttachment,
  owner_id: string,
  object_lock_policy?: ObjectLockPolicy,
): Promise<AttachmentEntry> {
  const has_content = att.content.length > 0;
  const digests = has_content ? compute_content_digests(ctx, att.content) : undefined;
  const checksum = digests?.checksum ?? '';
  const storage_key = digests ? `attachments/${owner_id}/${digests.content_name}` : '';

  if (has_content) {
    const exists = await ctx.storage.exists(storage_key);
    if (!exists) {
      const ciphertext = ctx.encrypt(att.content, storage_key);
      await ctx.storage.put(storage_key, ciphertext, undefined, object_lock_policy);
    }
  }

  return {
    attachment_id: att.attachment_id,
    name: att.name,
    content_type: att.content_type,
    size_bytes: att.size_bytes,
    storage_key,
    checksum,
    is_inline: att.is_inline,
    ...(att.content_id ? { content_id: att.content_id } : {}),
  };
}

const DEFAULT_ATTACHMENT_CONCURRENCY = 3;

/** A JSON-fallback message whose attachments still need fetching into `entries[entry_index]`. */
export interface PendingAttachment {
  entry_index: number;
  message_id: string;
}

/**
 * Drains all pending attachment fetches in parallel batches of `concurrency`.
 *
 * One failure used to reject the whole `Promise.all`, and the throw travelled out of
 * `sync_single_folder` into a folder-level error that discarded every entry already processed in
 * that folder. A message deleted between the delta page and the attachment fetch is enough to
 * trigger it, and Graph answers `ErrorItemNotFound` for that (issue #366).
 *
 * A permission or licensing failure still propagates: those are the operator's to fix, and
 * degrading the whole run quietly is the failure #372 describes.
 *
 * Returns false when an interrupt left attachments unfetched. Those messages are already in
 * `entries` without attachments, so the folder must not count as complete or its delta link
 * would skip them for good (issue #434).
 */
export async function flush_pending_attachments(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  entries: ManifestEntry[],
  stats: { stored: number; deduplicated: number; att_stored: number },
  pending: PendingAttachment[],
  attachment_errors: string[],
  is_interrupted: () => boolean,
  object_lock_policy?: ObjectLockPolicy,
  concurrency = DEFAULT_ATTACHMENT_CONCURRENCY,
): Promise<boolean> {
  while (pending.length > 0) {
    // An interrupted run stops scheduling; what is already in flight finishes.
    if (is_interrupted()) {
      pending.length = 0;
      return false;
    }
    const batch = pending.splice(0, concurrency);
    const tasks = batch.map(async (p) => {
      try {
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
      } catch (err) {
        if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(`Attachments for message ${p.message_id} could not be fetched: ${reason}`);
        attachment_errors.push(`message ${p.message_id}: attachments not backed up (${reason})`);
      }
    });

    await Promise.all(tasks);
  }
  return true;
}
