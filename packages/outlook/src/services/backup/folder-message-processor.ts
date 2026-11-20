import type {
  MailboxConnector,
  MailMessage,
  ManifestEntry,
  MessageExtendedProperties,
  ObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  capture_mime_payload,
  store_single_message,
} from '@/services/backup/message-payload-store';
import type { PendingAttachment } from '@/services/backup/attachment-storage-sync';

/**
 * Processes a single message: capture MIME, dedup check, encrypt, store.
 * MIME embeds its attachments, so only a JSON fallback queues a separate
 * attachment fetch. Reactions and pin were read for the whole page beforehand (issue #513).
 * A MIME capture that failed for now is recorded in `message_errors` (issue #614); one Exchange
 * refused for good is recorded on the entry and in `message_warnings` (issue #812).
 */
export async function process_message(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  message: MailMessage,
  properties: MessageExtendedProperties | undefined,
  entries: ManifestEntry[],
  stats: { stored: number; deduplicated: number; att_stored: number },
  pending_attachments: PendingAttachment[],
  message_errors: string[],
  message_warnings: string[],
  object_lock_policy?: ObjectLockPolicy,
): Promise<void> {
  const { mime, failure, unavailable } = await capture_mime_payload(
    connector,
    tenant_id,
    owner_id,
    message,
  );
  if (failure !== undefined) {
    message_errors.push(
      `message ${message.message_id}: original MIME not captured, stored from the JSON payload (${failure})`,
    );
  }
  if (unavailable !== undefined) {
    message_warnings.push(
      `message ${message.message_id}: Exchange cannot produce its original MIME (${unavailable}), stored from the JSON payload; not retried until the message changes`,
    );
  }
  const entry = await store_single_message(
    ctx,
    message,
    owner_id,
    object_lock_policy,
    mime,
    properties,
  );
  if (entry.was_new) stats.stored++;
  else stats.deduplicated++;

  const entry_index = entries.length;
  entries.push(
    unavailable === undefined
      ? entry.manifest_entry
      : { ...entry.manifest_entry, mime_unavailable: unavailable },
  );

  if (!mime && message.has_attachments) {
    pending_attachments.push({ entry_index, message_id: message.message_id });
  }
}
