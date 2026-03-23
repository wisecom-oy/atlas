import type { TenantContext } from '@/ports/tenant/context.port';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import type { AttachmentEntry } from '@/domain/manifest';
import { logger } from '@/utils/logger';

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
  mailbox_id: string,
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

      await restore_connector.add_attachment(tenant_id, mailbox_id, new_message_id, {
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

/** Fetches and decrypts a single attachment binary from object storage. */
async function decrypt_attachment(ctx: TenantContext, storage_key: string): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(storage_key);
  return ctx.decrypt(ciphertext);
}
