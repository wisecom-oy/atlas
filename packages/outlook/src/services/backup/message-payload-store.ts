import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  ExtendedProperty,
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

export interface PageReactions {
  /** Reaction properties per message id; an absent id has none recorded. */
  readonly by_message: ReadonlyMap<string, ExtendedProperty[]>;
  /** Messages on the page whose reactions could not be read. */
  readonly failed: number;
}

const NO_REACTIONS: PageReactions = { by_message: new Map(), failed: 0 };

/**
 * Captures the Outlook reaction properties of a page of messages in one batched read (issues
 * #481, #513). Access and licensing failures propagate as for MIME. Any other failure loses only
 * the reactions, never a message, and is counted so the run summary can report it: the delta link
 * moves past the page, so the reactions are read again only when the message changes.
 */
export async function capture_page_reactions(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  messages: readonly MailMessage[],
): Promise<PageReactions> {
  if (!connector.fetch_reaction_properties || messages.length === 0) return NO_REACTIONS;
  const ids = messages.map((m) => m.message_id);
  try {
    const by_message = await connector.fetch_reaction_properties(tenant_id, owner_id, ids);
    if (!by_message) return NO_REACTIONS;
    return { by_message, failed: ids.filter((id) => !by_message.has(id)).length };
  } catch (err) {
    if (err instanceof AuthError || err instanceof MailboxNotLicensedError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Reaction capture failed for ${ids.length} messages: ${reason}`);
    return { by_message: new Map(), failed: ids.length };
  }
}

/**
 * Content-addressed storage with keyed-hash dedup (issue #446): name -> check exists -> encrypt
 * -> upload. Stores `mime` when Graph produced it, otherwise the JSON payload
 * from the delta page; the manifest entry records which (issue #50).
 */
export async function store_single_message(
  ctx: TenantContext,
  message: MailMessage,
  owner_id: string,
  object_lock_policy?: ObjectLockPolicy,
  mime?: Buffer,
  reaction_properties: readonly ExtendedProperty[] = [],
): Promise<StoredMessage> {
  const payload = mime ?? message.raw_body;
  const { checksum, content_name } = compute_content_digests(ctx, payload);
  const storage_key = `data/${owner_id}/${content_name}`;

  const already_stored = await ctx.storage.exists(storage_key);
  if (!already_stored) {
    const ciphertext = ctx.encrypt(payload, storage_key);
    await ctx.storage.put(
      storage_key,
      ciphertext,
      {
        'x-message-id': message.message_id,
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
    ...(reaction_properties.length > 0 ? { reaction_properties } : {}),
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
