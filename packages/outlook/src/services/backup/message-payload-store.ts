import { createHash } from 'node:crypto';
import type {
  MailboxConnector,
  MailMessage,
  ManifestEntry,
  ObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

export interface StoredMessage {
  readonly manifest_entry: ManifestEntry;
  readonly was_new: boolean;
}

/**
 * Captures the message's original MIME, falling back to the JSON payload when
 * Graph has no MIME for the item. Access and licensing failures are rethrown by
 * the connector and propagate; anything else degrades this one message to JSON
 * rather than failing the folder (issue #50).
 */
export async function capture_mime_payload(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  message: MailMessage,
): Promise<Buffer | undefined> {
  if (!connector.fetch_mime) return undefined;
  try {
    return await connector.fetch_mime(tenant_id, owner_id, message.message_id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`MIME capture failed for message ${message.message_id}: ${reason}`);
    return undefined;
  }
}

/**
 * Content-addressed storage with SHA-256 dedup: hash -> check exists -> encrypt
 * -> upload. Stores `mime` when Graph produced it, otherwise the JSON payload
 * from the delta page; the manifest entry records which (issue #50).
 */
export async function store_single_message(
  ctx: TenantContext,
  message: MailMessage,
  owner_id: string,
  object_lock_policy?: ObjectLockPolicy,
  mime?: Buffer,
): Promise<StoredMessage> {
  const payload = mime ?? message.raw_body;
  const checksum = createHash('sha256').update(payload).digest('hex');
  const storage_key = `data/${owner_id}/${checksum}`;

  const already_stored = await ctx.storage.exists(storage_key);
  if (!already_stored) {
    const ciphertext = ctx.encrypt(payload);
    await ctx.storage.put(
      storage_key,
      ciphertext,
      {
        'x-message-id': message.message_id,
        'x-plaintext-sha256': checksum,
      },
      object_lock_policy,
    );
  }

  const manifest_entry: ManifestEntry = {
    object_id: message.message_id,
    storage_key,
    checksum,
    size_bytes: payload.length,
    subject: message.subject,
    folder_id: message.folder_id,
    ...(mime
      ? { payload_format: 'mime' as const, received_at: message.received_at.toISOString() }
      : {}),
  };

  return { manifest_entry, was_new: !already_stored };
}
