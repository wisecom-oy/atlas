import {
  WriteOutcomeUnknownError,
  type OutcomeUnknownMessage,
  type RestoreResult,
} from '@wisecom/atlas-types';
import type { AttachmentOutcomeUnknown } from '@/services/restore/restore-attachment-writer';

/**
 * The record of a message whose create may have committed although it failed, or undefined when
 * `err` is a refusal or any other failure that created nothing (issue #893).
 */
export function unknown_message_create(
  object_id: string,
  target_folder_id: string,
  error_line: string,
  err: unknown,
): OutcomeUnknownMessage | undefined {
  if (!(err instanceof WriteOutcomeUnknownError)) return undefined;
  return { object_id, target_folder_id, error: error_line };
}

/**
 * The records of a created message's attachments whose create may have committed. `line_prefix` is
 * what the run puts before each attachment line in `errors`, so `error` matches that line.
 */
export function unknown_attachment_creates(
  object_id: string,
  target_folder_id: string,
  attachments: readonly AttachmentOutcomeUnknown[],
  line_prefix: string,
): OutcomeUnknownMessage[] {
  return attachments.map((attachment) => ({
    object_id,
    target_folder_id,
    attachment_name: attachment.name,
    error: `${line_prefix}${attachment.error}`,
  }));
}

/** The result of a single-message restore whose message create may have committed. */
export function unknown_single_message_result(
  snapshot_id: string,
  restore_folder_name: string,
  unknown: OutcomeUnknownMessage,
): RestoreResult {
  return {
    snapshot_id,
    restored_count: 0,
    attachment_count: 0,
    error_count: 1,
    attachment_error_count: 0,
    errors: [unknown.error],
    verification_warnings: [],
    messages: [],
    restore_folder_name,
    outcome_unknown: [unknown],
    interrupted: false,
  };
}
