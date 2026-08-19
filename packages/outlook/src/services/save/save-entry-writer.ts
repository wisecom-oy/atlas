import type { TenantContext } from '@wisecom/atlas-types';
import type { ManifestEntry, AttachmentEntry } from '@wisecom/atlas-types';
import { build_eml, build_eml_filename, deduplicate_filename } from '@/services/save/eml-builder';
import { verify_checksum } from '@/services/save/save-integrity-validator';
import type { ArchiveWriter } from '@/services/save/save-zip-writer';
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
  archive: ArchiveWriter,
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
  archive: ArchiveWriter,
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
    if (!att.storage_key) continue;

    try {
      const content = await decrypt_and_verify_attachment(ctx, att, skip_integrity, result);
      decrypted.push({
        name: att.name,
        content_type: att.content_type,
        content,
        is_inline: att.is_inline,
        ...(att.content_id ? { content_id: att.content_id } : {}),
      });
    } catch (err) {
      logger.warn(
        `Failed to decrypt attachment "${att.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return decrypted;
}

async function decrypt_and_verify_attachment(
  ctx: TenantContext,
  att: AttachmentEntry,
  skip_integrity: boolean,
  result: EntryResult,
): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(att.storage_key);
  const plaintext = ctx.decrypt(ciphertext);

  if (!skip_integrity && att.checksum) {
    if (!verify_checksum(plaintext, att.checksum)) {
      result.integrity_fail++;
      result.integrity_failures.push(`attachment:${att.attachment_id}`);
      logger.warn(`Integrity check failed for attachment "${att.name}"`);
    } else {
      result.integrity_ok++;
    }
  }

  return plaintext;
}
