import type { TenantContext } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { AttachmentEntry, AttachmentKindCounts } from '@wisecom/atlas-types';
import type { MimeAttachment } from '@/services/shared/mime-message-parser';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  is_run_fatal_error,
  type RunFatalError,
} from '@wisecom/atlas-core/services/shared/run-fatal-error';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { assert_restored_content_matches } from '@wisecom/atlas-core/services/shared/restored-content-verifier';

export interface AttachmentRestoreResult {
  readonly restored: number;
  /** The restored attachments split by kind, as they were posted to Graph. */
  readonly uploaded: AttachmentKindCounts;
  readonly skipped: number;
  readonly errors: string[];
  /** A refusal for the whole mailbox that stopped the uploads; it ends the restore (#871). */
  readonly refusal?: RunFatalError;
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
  let refusal: RunFatalError | undefined;

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
      const stop = record_failed_upload(errors, att.name, attachments.length - index, err);
      if (stop === undefined) continue;
      refusal = stop.refusal;
      break;
    }
  }

  return with_refusal(
    { restored, uploaded: { file: restored - inline, inline }, skipped, errors },
    refusal,
  );
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
  let refusal: RunFatalError | undefined;

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
      const stop = record_failed_upload(errors, att.name, attachments.length - index, err);
      if (stop === undefined) continue;
      refusal = stop.refusal;
      break;
    }
  }

  return with_refusal(
    { restored, uploaded: { file: restored - inline, inline }, skipped: 0, errors },
    refusal,
  );
}

/** Why the remaining uploads of a message stop: Ctrl+C, or a refusal for the whole mailbox. */
interface UploadStop {
  readonly refusal?: RunFatalError;
}

/**
 * Records one failed attachment upload and says whether the remaining uploads stop. Ctrl+C and a
 * refusal for the whole mailbox stop them with one line for all that are left (#682, #871); any
 * other failure is the attachment's own, and the next one is still sent.
 */
function record_failed_upload(
  errors: string[],
  name: string,
  remaining: number,
  err: unknown,
): UploadStop | undefined {
  if (is_active_run_cancelled()) {
    errors.push(interrupted_attachments(remaining));
    return {};
  }
  if (is_run_fatal_error(err)) {
    errors.push(`${remaining} attachment(s) not uploaded: ${err.message}`);
    return { refusal: err };
  }
  errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  return undefined;
}

/** The result, carrying the refusal that stopped it when there was one. */
function with_refusal(
  result: AttachmentRestoreResult,
  refusal: RunFatalError | undefined,
): AttachmentRestoreResult {
  return refusal === undefined ? result : { ...result, refusal };
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
