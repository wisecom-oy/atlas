import type { TenantContext } from '@wisecom/atlas-types';
import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type { MailboxConnector, MessageAttachment } from '@wisecom/atlas-types';
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
