import type { TenantContext } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import type { MimeAddress, ParsedMimeMessage } from '@/services/shared/mime-message-parser';

/**
 * Read-only fields that Graph returns on GET but rejects on POST.
 * These must be stripped before creating a message via the API.
 */
const READ_ONLY_FIELDS = new Set([
  'id',
  'createdDateTime',
  'lastModifiedDateTime',
  'changeKey',
  'conversationId',
  'conversationIndex',
  'webLink',
  'bodyPreview',
  'parentFolderId',
  'hasAttachments',
]);

const ODATA_PREFIX = '@odata.';

/**
 * Writable fields that the Graph POST /messages endpoint accepts.
 * Using an allow-list is safer than a deny-list for forward compatibility.
 */
const WRITABLE_FIELDS = new Set([
  'subject',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'importance',
  'isRead',
  'isDraft',
  'flag',
  'categories',
  'internetMessageId',
  'internetMessageHeaders',
  'inferenceClassification',
  'singleValueExtendedProperties',
  'multiValueExtendedProperties',
]);

/**
 * Decrypts a manifest entry from storage and parses the JSON payload.
 * Returns the raw Graph message object as stored during backup.
 */
export async function decrypt_and_parse_message(
  ctx: TenantContext,
  entry: ManifestEntry,
): Promise<Record<string, unknown>> {
  const ciphertext = await ctx.storage.get(entry.storage_key);
  const plaintext = ctx.decrypt(ciphertext);
  return JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>;
}

/**
 * Decrypts a `payload_format: 'mime'` manifest entry and parses the RFC 5322
 * bytes stored during backup.
 */
export async function decrypt_and_parse_mime(
  ctx: TenantContext,
  entry: ManifestEntry,
): Promise<ParsedMimeMessage> {
  const ciphertext = await ctx.storage.get(entry.storage_key);
  return parse_mime_message(ctx.decrypt(ciphertext));
}

/**
 * MAPI extended properties used to override Graph's default behavior
 * when restoring messages via POST (which always creates drafts with
 * the current timestamp).
 *
 * PR_MESSAGE_FLAGS (0x0E07) -- controls draft/read state
 * PR_MESSAGE_DELIVERY_TIME (0x0E06) -- receivedDateTime
 * PR_CLIENT_SUBMIT_TIME (0x0039) -- sentDateTime
 */
const PR_MESSAGE_FLAGS = 'Integer 0x0E07';
const PR_MESSAGE_DELIVERY_TIME = 'SystemTime 0x0E06';
const PR_CLIENT_SUBMIT_TIME = 'SystemTime 0x0039';
const MSGFLAG_READ = 0x01;

/**
 * Strips read-only and OData metadata fields from a stored Graph message,
 * keeping only writable properties. Uses MAPI extended properties to
 * override Graph's default draft behavior and preserve original timestamps.
 */
export function sanitize_message_for_restore(
  message_json: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(message_json)) {
    if (key.startsWith(ODATA_PREFIX)) continue;
    if (READ_ONLY_FIELDS.has(key)) continue;
    if (!WRITABLE_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }

  sanitized['isDraft'] = false;
  sanitized['singleValueExtendedProperties'] = build_mapi_overrides({
    is_read: Boolean(message_json['isRead']),
    received_at: as_iso_string(message_json['receivedDateTime']),
    sent_at: as_iso_string(message_json['sentDateTime']),
  });

  return sanitized;
}

/** Timestamps and read state that drive the MAPI overrides, from JSON or MIME. */
interface MapiOverrideSource {
  readonly is_read: boolean;
  readonly received_at?: string | undefined;
  readonly sent_at?: string | undefined;
}

/** Builds the MAPI extended property array for draft flag and timestamps. */
function build_mapi_overrides(source: MapiOverrideSource): Array<{ id: string; value: string }> {
  const props: Array<{ id: string; value: string }> = [
    { id: PR_MESSAGE_FLAGS, value: String(source.is_read ? MSGFLAG_READ : 0) },
  ];

  if (source.received_at) props.push({ id: PR_MESSAGE_DELIVERY_TIME, value: source.received_at });
  if (source.sent_at) props.push({ id: PR_CLIENT_SUBMIT_TIME, value: source.sent_at });

  return props;
}

/** Narrows an unknown stored field to a string, dropping non-string values. */
function as_iso_string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extracts the parentFolderId from a decrypted Graph message JSON.
 * Used as fallback when ManifestEntry.folder_id is not populated (legacy manifests).
 */
export function extract_folder_id_from_json(message_json: Record<string, unknown>): string {
  return (message_json['parentFolderId'] as string) ?? '__unknown__';
}

/**
 * Builds the Graph create-message payload for a MIME-backed entry.
 *
 * Restore deliberately does not import MIME through Graph: messages created
 * from MIME are always `isDraft: true` and that flag cannot be cleared, so a
 * mailbox restore would land as thousands of drafts. Parsing the MIME and
 * feeding the normal JSON create path keeps the existing restore quality.
 */
export function build_restore_payload_from_mime(
  parsed: ParsedMimeMessage,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    subject: parsed.subject,
    body: parsed.html
      ? { contentType: 'html', content: parsed.html }
      : { contentType: 'text', content: parsed.text ?? '' },
    toRecipients: parsed.to.map(to_graph_recipient),
    ccRecipients: parsed.cc.map(to_graph_recipient),
    isDraft: false,
    // ponytail: MIME carries no read state, so restored mail is marked read
    // rather than dumping thousands of unread items on the user.
    singleValueExtendedProperties: build_mapi_overrides({
      is_read: true,
      received_at: parsed.date,
      sent_at: parsed.date,
    }),
  };

  if (parsed.from) payload['from'] = to_graph_recipient(parsed.from);
  if (parsed.message_id) payload['internetMessageId'] = parsed.message_id;

  return payload;
}

/** Wraps a parsed MIME address in Graph's recipient envelope. */
function to_graph_recipient(address: MimeAddress): {
  emailAddress: { name: string; address: string };
} {
  return { emailAddress: { name: address.name, address: address.address } };
}
