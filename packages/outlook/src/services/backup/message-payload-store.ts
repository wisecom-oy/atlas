import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  MailAddress,
  MailboxConnector,
  MailMessage,
  ManifestEntry,
  MessageExtendedProperties,
  ObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { AuthError, MailboxNotLicensedError, MimeUnavailableError } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { is_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
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

/** The result of one MIME capture. */
export interface MimeCapture {
  /** The original MIME, or undefined when the JSON payload stands in for it. */
  readonly mime: Buffer | undefined;
  /** Why a capture that could succeed on a later run failed; absent when it did not fail. */
  readonly failure?: string;
  /** The Graph error code with which Exchange refused the MIME for good (issue #812). */
  readonly unavailable?: string;
}

/**
 * Captures the message's original MIME (issue #50). The connector resolves undefined when it has
 * no MIME to offer, and the JSON payload is then the message's backup. Any other rejection that is
 * this message's own, such as a `400` or `401`, or a `404` for a message deleted since its page
 * was read, is a capture that failed for now: the JSON payload is still stored so the run keeps
 * the message, and `failure` tells the caller to withhold the folder's delta link so the next run
 * captures the MIME (issues #614, #849). A deleted message holds the link back once: the next
 * run's delta reports it removed instead of listing it, so no MIME is requested for it. A
 * `MimeUnavailableError` is permanent for the message, so it sets `unavailable` instead and the
 * folder still completes (issue #812). An empty MIME is a
 * failure too: zero bytes are never a message, and storing them as MIME would lose its content
 * with the folder reported complete (issue #848). Access and licensing failures propagate (issue
 * #372), and so does an exhausted retry budget, which is an outage (issue #881).
 */
export async function capture_mime_payload(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  message: MailMessage,
): Promise<MimeCapture> {
  if (!connector.fetch_mime) return { mime: undefined };
  try {
    const mime = await connector.fetch_mime(tenant_id, owner_id, message.message_id);
    return mime?.length === 0 ? empty_mime_failure(message.message_id) : { mime };
  } catch (err) {
    if (is_unrecordable_failure(err)) throw err;
    if (err instanceof MimeUnavailableError) {
      return { mime: undefined, unavailable: err.graph_code };
    }
    const reason = describe_capture_failure(err);
    logger.warn(`MIME capture failed for message ${message.message_id}: ${reason}`);
    return { mime: undefined, failure: reason };
  }
}

/** The capture of a MIME that arrived with no bytes: a failure for now, so the next run asks again. */
function empty_mime_failure(message_id: string): MimeCapture {
  const reason = 'Graph returned an empty MIME body';
  logger.warn(`MIME capture failed for message ${message_id}: ${reason}`);
  return { mime: undefined, failure: reason };
}

/**
 * A failure the caller must not record against one message: lost access or licence ends the run
 * (issue #372), a Graph call cut short by cancellation is the run stopping (issue #673), and an
 * exhausted retry budget is a Graph outage that fails the folder, which keeps its delta link,
 * rather than a JSON stand-in stored for every message left on the page (issue #881).
 */
export function is_unrecordable_failure(err: unknown): boolean {
  return (
    err instanceof AuthError ||
    err instanceof MailboxNotLicensedError ||
    is_graph_outage(err) ||
    is_active_run_cancelled()
  );
}

/**
 * The error message, or its HTTP status and Graph error code when it has none. Graph errors for
 * binary responses such as `$value` carry no message, and an empty reason would leave the operator
 * nothing to act on.
 */
function describe_capture_failure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message) return message;
  const { statusCode: status, code } = (err ?? {}) as { statusCode?: unknown; code?: unknown };
  if (typeof status !== 'number') return 'unknown error';
  return typeof code === 'string' && code !== '' ? `HTTP ${status} ${code}` : `HTTP ${status}`;
}

export interface PageExtendedProperties {
  /** Reaction and pin properties per message id; an absent id has none recorded. */
  readonly by_message: ReadonlyMap<string, MessageExtendedProperties>;
  /** Messages on the page whose reactions and pin could not be read. */
  readonly failed: number;
}

const NO_PROPERTIES: PageExtendedProperties = { by_message: new Map(), failed: 0 };

const NO_MESSAGE_PROPERTIES: MessageExtendedProperties = {
  reaction_properties: [],
  pin_properties: [],
};

/**
 * Captures the Outlook reaction and pin properties of a page of messages in one batched read
 * (issues #481, #513, #579). Access, licensing and outage failures propagate as for MIME. Any
 * other failure loses only that metadata, never a message, and is counted so the run summary can
 * report it: the delta link moves past the page, so it is read again only when the message changes.
 */
export async function capture_page_extended_properties(
  connector: MailboxConnector,
  tenant_id: string,
  owner_id: string,
  messages: readonly MailMessage[],
): Promise<PageExtendedProperties> {
  if (!connector.fetch_extended_properties || messages.length === 0) return NO_PROPERTIES;
  const ids = messages.map((m) => m.message_id);
  try {
    const by_message = await connector.fetch_extended_properties(tenant_id, owner_id, ids);
    if (!by_message) return NO_PROPERTIES;
    return { by_message, failed: ids.filter((id) => !by_message.has(id)).length };
  } catch (err) {
    if (is_unrecordable_failure(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Reaction and pin capture failed for ${ids.length} messages: ${reason}`);
    return { by_message: new Map(), failed: ids.length };
  }
}

/**
 * Content-addressed storage with keyed-hash dedup (issue #446): name -> check exists -> encrypt
 * -> upload. Stores `mime` when Graph produced it, otherwise the JSON payload
 * from the delta page; the manifest entry records which (issue #50). The follow-up flag, reactions
 * and pin go on the entry, since no payload format carries them all (issues #481, #579).
 */
export async function store_single_message(
  ctx: TenantContext,
  message: MailMessage,
  owner_id: string,
  object_lock_policy?: ObjectLockPolicy,
  mime?: Buffer,
  properties: MessageExtendedProperties = NO_MESSAGE_PROPERTIES,
): Promise<StoredMessage> {
  const { reaction_properties, pin_properties } = properties;
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
    ...(message.flag ? { flag: message.flag } : {}),
    ...(pin_properties.length > 0 ? { pin_properties } : {}),
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
