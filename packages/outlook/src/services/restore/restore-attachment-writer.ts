import type { TenantContext } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { AttachmentEntry } from '@wisecom/atlas-types';
import type { MimeAttachment } from '@/services/shared/mime-message-parser';
import { logger } from '@wisecom/atlas-core/utils/logger';

export interface AttachmentRestoreResult {
  readonly restored: number;
  readonly skipped: number;
  readonly errors: string[];
}

/**
 * Restores all attachments for a message by decrypting from storage
 * and uploading to the newly created Graph message.
 * Attachments without a storage_key (never backed up) are skipped with a warning.
 */
export async function restore_entry_attachments(
  ctx: TenantContext,
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  new_message_id: string,
  attachments: AttachmentEntry[],
): Promise<AttachmentRestoreResult> {
  let restored = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const att of attachments) {
    if (!att.storage_key) {
      logger.warn(`Attachment "${att.name}" was not backed up (too large) -- skipping restore`);
      skipped++;
      continue;
    }

    try {
      const content = await decrypt_attachment(ctx, att.storage_key);

      await restore_connector.add_attachment(tenant_id, owner_id, new_message_id, {
        name: att.name,
        content_type: att.content_type,
        content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });

      restored++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${att.name}: ${msg}`);
    }
  }

  return { restored, skipped, errors };
}

/**
 * Uploads attachments that were parsed out of a MIME blob. Unlike the JSON
 * path these bytes are already in hand, so nothing is fetched from storage
 * and nothing can be skipped for missing content.
 */
export async function restore_parsed_attachments(
  restore_connector: RestoreConnector,
  tenant_id: string,
  owner_id: string,
  new_message_id: string,
  attachments: readonly MimeAttachment[],
): Promise<AttachmentRestoreResult> {
  let restored = 0;
  const errors: string[] = [];

  for (const att of attachments) {
    try {
      await restore_connector.add_attachment(tenant_id, owner_id, new_message_id, {
        name: att.name,
        content_type: att.content_type,
        content: att.content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });
      restored++;
    } catch (err) {
      errors.push(`${att.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { restored, skipped: 0, errors };
}

/** Fetches and decrypts a single attachment binary from object storage. */
async function decrypt_attachment(ctx: TenantContext, storage_key: string): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(storage_key);
  return ctx.decrypt(ciphertext);
}
