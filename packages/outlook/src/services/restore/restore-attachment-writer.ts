import type { TenantContext } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { AttachmentEntry, AttachmentKindCounts } from '@wisecom/atlas-types';
import type { MimeAttachment } from '@/services/shared/mime-message-parser';
import { WriteOutcomeUnknownError } from '@wisecom/atlas-types';
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
  /** The attachments among `errors` whose create may have committed (issue #893). */
  readonly outcome_unknown: AttachmentOutcomeUnknown[];
  /** A refusal for the whole mailbox that stopped the uploads; it ends the restore (#871). */
  readonly refusal?: RunFatalError;
}

/** An attachment whose create ended without a clear answer, so it may be on the message. */
export interface AttachmentOutcomeUnknown {
  readonly name: string;
  /** The line recorded for it in `errors`. */
  readonly error: string;
}

/** What failed among one message's attachment uploads. */
interface UploadFailures {
  readonly errors: string[];
  readonly outcome_unknown: AttachmentOutcomeUnknown[];
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
  const failures: UploadFailures = { errors: [], outcome_unknown: [] };
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
      const stop = record_failed_upload(failures, att.name, attachments.length - index, err);
      if (stop === undefined) continue;
      refusal = stop.refusal;
      break;
    }
  }

  return with_refusal(
    { restored, uploaded: { file: restored - inline, inline }, skipped, ...failures },
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
  const failures: UploadFailures = { errors: [], outcome_unknown: [] };
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
      const stop = record_failed_upload(failures, att.name, attachments.length - index, err);
      if (stop === undefined) continue;
      refusal = stop.refusal;
      break;
    }
  }

  return with_refusal(
    { restored, uploaded: { file: restored - inline, inline }, skipped: 0, ...failures },
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
  failures: UploadFailures,
  name: string,
  remaining: number,
  err: unknown,
): UploadStop | undefined {
  if (is_active_run_cancelled()) {
    record_interrupted_upload(failures, name, remaining, err);
    return {};
  }
  if (is_run_fatal_error(err)) {
    failures.errors.push(`${remaining} attachment(s) not uploaded: ${err.message}`);
    return { refusal: err };
  }
  record_attachment_error(failures, name, err);
  return undefined;
}

/**
 * Records one attachment's failure line, and names the attachment as possibly on the message when
 * its create ended without a clear answer (issue #893).
 */
function record_attachment_error(failures: UploadFailures, name: string, err: unknown): void {
  const line = `${name}: ${err instanceof Error ? err.message : String(err)}`;
  failures.errors.push(line);
  if (err instanceof WriteOutcomeUnknownError) failures.outcome_unknown.push({ name, error: line });
}

/** The result, carrying the refusal that stopped it when there was one. */
function with_refusal(
  result: AttachmentRestoreResult,
  refusal: RunFatalError | undefined,
): AttachmentRestoreResult {
  return refusal === undefined ? result : { ...result, refusal };
}

/**
 * Records the attachments a cancelled run did not upload, in one line, after naming an attachment
 * whose create was sent and may have landed (issues #891, #893).
 */
function record_interrupted_upload(
  failures: UploadFailures,
  name: string,
  remaining: number,
  err: unknown,
): void {
  if (!(err instanceof WriteOutcomeUnknownError)) {
    failures.errors.push(interrupted_attachments(remaining));
    return;
  }
  record_attachment_error(failures, name, err);
  if (remaining > 1) failures.errors.push(interrupted_attachments(remaining - 1));
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
