import { createHash } from 'node:crypto';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { MailboxConnector, MessageAttachment } from '@/ports/mailbox/connector.port';
import type { AttachmentEntry } from '@/domain/manifest';
import type { ObjectLockPolicy } from '@/ports/backup/use-case.port';

/** Invoked after each attachment is stored: (done_so_far, total_attachments). */
export type AttachmentProgressCallback = (done: number, total: number) => void;

/**
 * Fetches attachments for a message via the connector and stores each one
 * using content-addressed keys under attachments/{mailbox}/{sha256}.
 * The optional on_progress callback fires after each attachment is processed.
 */
export async function fetch_and_store_attachments(
  ctx: TenantContext,
  connector: MailboxConnector,
  tenant_id: string,
  mailbox_id: string,
  message_id: string,
  on_progress?: AttachmentProgressCallback,
  object_lock_policy?: ObjectLockPolicy,
): Promise<AttachmentEntry[]> {
  const raw = await connector.fetch_attachments(tenant_id, mailbox_id, message_id);
  const entries: AttachmentEntry[] = [];

  for (let i = 0; i < raw.length; i++) {
    entries.push(await store_single_attachment(ctx, raw[i]!, mailbox_id, object_lock_policy));
    on_progress?.(i + 1, raw.length);
  }
  return entries;
}

/** Content-addressed storage for a single attachment, same dedup pattern as messages. */
async function store_single_attachment(
  ctx: TenantContext,
  att: MessageAttachment,
  mailbox_id: string,
  object_lock_policy?: ObjectLockPolicy,
): Promise<AttachmentEntry> {
  const has_content = att.content.length > 0;
  const checksum = has_content ? createHash('sha256').update(att.content).digest('hex') : '';
  const storage_key = has_content ? `attachments/${mailbox_id}/${checksum}` : '';

  if (has_content) {
    const exists = await ctx.storage.exists(storage_key);
    if (!exists) {
      const ciphertext = ctx.encrypt(att.content);
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
