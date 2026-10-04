import { createHash } from 'node:crypto';
import type {
  MailAddress,
  MailboxConnector,
  MailMessage,
  ManifestEntry,
  ObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { parse_mime_envelope } from '@/services/shared/mime-message-parser';
import type { MimeEnvelope } from '@/services/shared/mime-message-parser';

export interface StoredMessage {
  readonly manifest_entry: ManifestEntry;
  readonly was_new: boolean;
}

interface MessageMetadata {
  readonly subject: string;
  readonly from?: MailAddress | undefined;
  readonly received_at?: Date | undefined;
}
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
    // The fallback is for per-message faults such as ErrorItemNotFound. A revoked permission or
    // an unlicensed mailbox is neither: swallowing those degraded every message in the run to
    // the JSON payload, lost the original MIME, and still exited 0. `fetch_message_mime` already
    // raises them as typed errors; this is the catch that used to eat them (issue #372).
    if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
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
    const ciphertext = ctx.encrypt(payload, storage_key);
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

  const metadata = await resolve_message_metadata(message, mime);
  const manifest_entry: ManifestEntry = {
    object_id: message.message_id,
    storage_key,
    checksum,
    size_bytes: payload.length,
    subject: metadata.subject,
    folder_id: message.folder_id,
    ...(metadata.from ? { from: metadata.from } : {}),
    ...(mime ? { payload_format: 'mime' as const } : {}),
    ...(mime && metadata.received_at ? { received_at: metadata.received_at.toISOString() } : {}),
  };

  return { manifest_entry, was_new: !already_stored };
}

/**
 * Fills subject, sender and receive time the delta item left out from the captured MIME headers.
 * Graph can return an updated message without them, and the blanks would then replace the correct
 * metadata of earlier snapshots in every folded view (issue #459). A JSON payload is the delta item
 * itself, so it has nothing more to offer.
 */
async function resolve_message_metadata(
  message: MailMessage,
  mime: Buffer | undefined,
): Promise<MessageMetadata> {
  const { subject, from, received_at } = message;
  if (!mime || (subject !== undefined && from && received_at)) {
    return { subject: subject ?? '', from, received_at };
  }
  const envelope = await read_mime_envelope(message.message_id, mime);
  return {
    subject: subject ?? envelope.subject ?? '',
    from: from ?? to_mail_address(envelope.from),
    received_at: received_at ?? envelope.date,
  };
}

/** Parses the MIME headers; a failure keeps the delta metadata rather than failing the backup. */
async function read_mime_envelope(message_id: string, mime: Buffer): Promise<MimeEnvelope> {
  try {
    return await parse_mime_envelope(mime);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`MIME header parse failed for message ${message_id}: ${reason}`);
    return {};
  }
}

/** Maps a parsed MIME address to the manifest shape, omitting an empty display name. */
function to_mail_address(address: MimeEnvelope['from']): MailAddress | undefined {
  if (!address) return undefined;
  return address.name
    ? { name: address.name, address: address.address }
    : { address: address.address };
}
