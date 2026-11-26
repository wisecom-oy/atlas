import type { TenantContext } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { AttachmentEntry, AttachmentKindCounts } from '@wisecom/atlas-types';
import type { MimeAttachment } from '@/services/shared/mime-message-parser';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { assert_restored_content_matches } from '@wisecom/atlas-core/services/shared/restored-content-verifier';

export interface AttachmentRestoreResult {
  readonly restored: number;
  /** The restored attachments split by kind, as they were posted to Graph. */
  readonly uploaded: AttachmentKindCounts;
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
  let inline = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [index, att] of attachments.entries()) {
    if (!att.storage_key) {
      logger.warn(`Attachment "${att.name}" was not backed up (too large) -- skipping restore`);
      skipped++;
      continue;
    }

    try {
      const content = await decrypt_attachment(ctx, att);

      await restore_connector.add_attachment(tenant_id, owner_id, new_message_id, {
        name: att.name,
        content_type: att.content_type,
        content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });

      restored++;
      if (att.is_inline) inline++;
    } catch (err) {
      const interrupted = record_attachment_failure(
        errors,
        att.name,
        err,
        attachments.length - index,
      );
      if (interrupted) break;
    }
  }

  return { restored, uploaded: { file: restored - inline, inline }, skipped, errors };
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
  let inline = 0;
  const errors: string[] = [];

  for (const [index, att] of attachments.entries()) {
    try {
      await restore_connector.add_attachment(tenant_id, owner_id, new_message_id, {
        name: att.name,
        content_type: att.content_type,
        content: att.content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });
      restored++;
      if (att.is_inline) inline++;
    } catch (err) {
      const interrupted = record_attachment_failure(
        errors,
        att.name,
        err,
        attachments.length - index,
      );
      if (interrupted) break;
    }
  }

  return { restored, uploaded: { file: restored - inline, inline }, skipped: 0, errors };
}

/**
 * Records why an attachment was not uploaded and returns whether the run was cancelled, which ends
 * the message's uploads. A cancelled run reports the attachments it did not upload in one line,
 * after naming an attachment whose final chunk may have landed (issue #891).
 */
function record_attachment_failure(
  errors: string[],
  name: string,
  err: unknown,
  remaining: number,
): boolean {
  const failure = `${name}: ${err instanceof Error ? err.message : String(err)}`;
  if (!is_active_run_cancelled()) {
    errors.push(failure);
    return false;
  }
  if (err instanceof UploadCommitUnknownError) {
    errors.push(failure);
    if (remaining > 1) errors.push(interrupted_attachments(remaining - 1));
    return true;
  }
  errors.push(interrupted_attachments(remaining));
  return true;
}

/**
 * One line for the attachments a cancelled run did not upload. The message already exists, so it is
 * reported as missing content, once, rather than as a failure per remaining attachment (#682).
 */
function interrupted_attachments(remaining: number): string {
  return `${remaining} attachment(s) not uploaded: the run was interrupted`;
}

/**
 * Fetches and decrypts a single attachment binary from object storage.
 *
 * Verified against the manifest checksum before it is returned, so a substituted blob fails the
 * entry rather than being uploaded under another attachment's name (issue #340).
 */
async function decrypt_attachment(ctx: TenantContext, att: AttachmentEntry): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(att.storage_key);
  const content = ctx.decrypt(ciphertext, att.storage_key);
  assert_restored_content_matches(`attachment "${att.name}"`, content, att.checksum);
  return content;
}
