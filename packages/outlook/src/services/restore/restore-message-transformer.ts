import type { TenantContext } from '@wisecom/atlas-types';
import type { ExtendedProperty, ManifestEntry } from '@wisecom/atlas-types';
import { assert_restored_content_matches } from '@wisecom/atlas-core/services/shared/restored-content-verifier';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import type {
  MimeAddress,
  MimeHeader,
  ParsedMimeMessage,
} from '@/services/shared/mime-message-parser';

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
 *
 * The checksum is compared before the bytes are parsed, so a substituted object fails here rather
 * than reaching `create_message` (issue #340).
 */
export async function decrypt_and_parse_message(
  ctx: TenantContext,
  entry: ManifestEntry,
): Promise<Record<string, unknown>> {
  const plaintext = await decrypt_verified_entry(ctx, entry);
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
  return parse_mime_message(await decrypt_verified_entry(ctx, entry));
}

/** Fetches, decrypts and checksum-verifies one entry's stored payload. */
async function decrypt_verified_entry(ctx: TenantContext, entry: ManifestEntry): Promise<Buffer> {
  const ciphertext = await ctx.storage.get(entry.storage_key);
  const plaintext = ctx.decrypt(ciphertext, entry.storage_key);
  assert_restored_content_matches(`message ${entry.object_id}`, plaintext, entry.checksum);
  return plaintext;
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
 * override Graph's default draft behavior and preserve original timestamps,
 * and appends the reaction properties captured at backup (issue #481).
 */
export function sanitize_message_for_restore(
  message_json: Record<string, unknown>,
  reaction_properties: readonly ExtendedProperty[] = [],
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(message_json)) {
    if (key.startsWith(ODATA_PREFIX)) continue;
    if (READ_ONLY_FIELDS.has(key)) continue;
    if (!WRITABLE_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }

  sanitized['isDraft'] = false;
  sanitized['singleValueExtendedProperties'] = [
    ...build_mapi_overrides({
      is_read: Boolean(message_json['isRead']),
      received_at: as_iso_string(message_json['receivedDateTime']),
      sent_at: as_iso_string(message_json['sentDateTime']),
    }),
    ...reaction_properties,
  ];

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
  reaction_properties: readonly ExtendedProperty[] = [],
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
    singleValueExtendedProperties: [
      ...build_mapi_overrides({ is_read: true, received_at: parsed.date, sent_at: parsed.date }),
      ...build_threading_properties(parsed.headers),
      ...reaction_properties,
    ],
  };

  if (parsed.from) payload['from'] = to_graph_recipient(parsed.from);
  if (parsed.message_id) payload['internetMessageId'] = parsed.message_id;
  if (parsed.bcc.length > 0) payload['bccRecipients'] = parsed.bcc.map(to_graph_recipient);
  if (parsed.reply_to.length > 0) payload['replyTo'] = parsed.reply_to.map(to_graph_recipient);

  const importance = read_importance(parsed.headers);
  if (importance) payload['importance'] = importance;
  const categories = read_categories(parsed.headers);
  if (categories.length > 0) payload['categories'] = categories;

  return payload;
}

/**
 * Graph accepts only `x-` headers in `internetMessageHeaders` on create, so the headers Exchange
 * groups conversations by are written as their MAPI properties instead (issue #478).
 */
const THREADING_PROPERTIES = [
  { header: 'in-reply-to', id: 'String 0x1042' }, // PR_IN_REPLY_TO_ID
  { header: 'references', id: 'String 0x1039' }, // PR_INTERNET_REFERENCES
  { header: 'thread-index', id: 'Binary 0x0071' }, // PR_CONVERSATION_INDEX, base64 like the header
] as const;

/** Maps the threading headers the MIME carries to MAPI properties; absent headers add nothing. */
function build_threading_properties(
  headers: readonly MimeHeader[],
): Array<{ id: string; value: string }> {
  return THREADING_PROPERTIES.flatMap(({ header, id }) => {
    const value = find_header(headers, header)?.trim();
    return value ? [{ id, value }] : [];
  });
}

/** Returns the value of the first header with this name, compared case-insensitively. */
function find_header(headers: readonly MimeHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

/**
 * Maps `Importance`, or `X-Priority` when it is absent, to Graph's importance. X-Priority runs
 * 1 (highest) to 5 (lowest) and often carries a label, as in `1 (Highest)` (issue #477).
 */
function read_importance(headers: readonly MimeHeader[]): 'low' | 'normal' | 'high' | undefined {
  const importance = find_header(headers, 'importance')?.trim().toLowerCase();
  if (importance === 'low' || importance === 'normal' || importance === 'high') return importance;

  const priority = Number.parseInt(find_header(headers, 'x-priority') ?? '', 10);
  if (priority === 1 || priority === 2) return 'high';
  if (priority === 3) return 'normal';
  if (priority === 4 || priority === 5) return 'low';
  return undefined;
}

/** Reads Outlook categories, which Exchange writes into the comma-separated `Keywords` header. */
function read_categories(headers: readonly MimeHeader[]): string[] {
  return (find_header(headers, 'keywords') ?? '')
    .split(',')
    .map((category) => category.trim())
    .filter((category) => category.length > 0);
}

/** Wraps a parsed MIME address in Graph's recipient envelope. */
function to_graph_recipient(address: MimeAddress): {
  emailAddress: { name: string; address: string };
} {
  return { emailAddress: { name: address.name, address: address.address } };
}
