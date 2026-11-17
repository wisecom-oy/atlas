import type { TenantContext } from '@wisecom/atlas-types';
import type { ManifestEntry, AttachmentEntry } from '@wisecom/atlas-types';
import { build_eml, build_eml_filename, deduplicate_filename } from '@/services/save/eml-builder';
import { verify_checksum } from '@/services/save/save-integrity-validator';
import type { SaveArchive } from '@/services/save/save-zip-writer';
import { add_eml_to_archive } from '@/services/save/save-zip-writer';
import { logger } from '@wisecom/atlas-core/utils/logger';

interface DecryptedAttachment {
  readonly name: string;
  readonly content_type: string;
  readonly content: Buffer;
  readonly is_inline: boolean;
  readonly content_id?: string;
}

/** Per-entry counters accumulated while writing one message into the archive. */
export interface EntryResult {
  attachment_count: number;
  integrity_ok: number;
  integrity_fail: number;
  integrity_failures: string[];
}

/**
 * Writes an entry whose stored blob already is RFC 5322 MIME straight into the
 * archive, byte-for-byte. Graph embeds attachments in the MIME, so nothing is
 * parsed, rebuilt or fetched — that is what preserves the Received chain,
 * DKIM/ARC results, threading headers and S/MIME payloads.
 */
export async function save_mime_entry(
  entry: ManifestEntry,
  folder_name: string,
  mime: Buffer,
  archive: SaveArchive,
  used_names: Set<string>,
): Promise<void> {
  const raw_filename = build_eml_filename(entry.received_at, entry.subject);
  const filename = deduplicate_filename(raw_filename, used_names);

  await add_eml_to_archive(archive, folder_name, filename, mime);
}

/**
 * Writes a legacy Graph JSON entry by decrypting its separately stored
 * attachments and reconstructing an EML from them.
 */
export async function save_json_entry(
  ctx: TenantContext,
  entry: ManifestEntry,
  folder_name: string,
  plaintext: Buffer,
  skip_integrity: boolean,
  archive: SaveArchive,
  used_names: Set<string>,
  result: EntryResult,
): Promise<void> {
  const message_json = JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>;
  const attachments = await decrypt_entry_attachments(ctx, entry, skip_integrity, result);

  const eml_buffer = build_eml(message_json, attachments);
  const received = message_json['receivedDateTime'] as string | undefined;
  const subject = message_json['subject'] as string | undefined;
  const raw_filename = build_eml_filename(received, subject);
  const filename = deduplicate_filename(raw_filename, used_names);

  await add_eml_to_archive(archive, folder_name, filename, eml_buffer);
  result.attachment_count = attachments.length;
}

async function decrypt_entry_attachments(
  ctx: TenantContext,
  entry: ManifestEntry,
  skip_integrity: boolean,
  result: EntryResult,
): Promise<DecryptedAttachment[]> {
  if (!entry.attachments || entry.attachments.length === 0) return [];

  const decrypted: DecryptedAttachment[] = [];

  for (const att of entry.attachments) {
    if (!att.storage_key) {
      // A zero-byte attachment has no stored blob; any other one lost its content.
      if (att.size_bytes > 0) {
        record_attachment_failure(result, entry.object_id, att, 'no stored content');
      }
      continue;
    }

    try {
      const content = await decrypt_and_verify_attachment(
        ctx,
        entry.object_id,
        att,
        skip_integrity,
        result,
      );
      decrypted.push({
        name: att.name,
        content_type: att.content_type,
        content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });
    } catch (err) {
      record_attachment_failure(
        result,
        entry.object_id,
        att,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return decrypted;
}

async function decrypt_and_verify_attachment(
  ctx: TenantContext,
  message_id: string,
  att: AttachmentEntry,
  skip_integrity: boolean,
  result: EntryResult,
): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(att.storage_key);
  const plaintext = ctx.decrypt(ciphertext, att.storage_key);

  if (!skip_integrity && att.checksum) {
    if (!verify_checksum(plaintext, att.checksum)) {
      record_attachment_failure(result, message_id, att, 'checksum mismatch');
    } else {
      result.integrity_ok++;
    }
  }

  return plaintext;
}

/** Records an attachment that save could not write intact, so the run reports a partial result. */
function record_attachment_failure(
  result: EntryResult,
  message_id: string,
  att: AttachmentEntry,
  reason: string,
): void {
  result.integrity_fail++;
  result.integrity_failures.push(`message:${message_id} attachment:${att.attachment_id}`);
  logger.warn(`Attachment "${att.name}" of message ${message_id} not saved intact: ${reason}`);
}
