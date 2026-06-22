import type { TenantContext } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';

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
  sanitized['singleValueExtendedProperties'] = build_mapi_overrides(message_json);

  return sanitized;
}

/** Builds the MAPI extended property array for draft flag and timestamps. */
function build_mapi_overrides(
  message_json: Record<string, unknown>,
): Array<{ id: string; value: string }> {
  const flags = message_json['isRead'] ? MSGFLAG_READ : 0;
  const props: Array<{ id: string; value: string }> = [
    { id: PR_MESSAGE_FLAGS, value: String(flags) },
  ];

  const received = message_json['receivedDateTime'];
  if (typeof received === 'string') {
    props.push({ id: PR_MESSAGE_DELIVERY_TIME, value: received });
  }

  const sent = message_json['sentDateTime'];
  if (typeof sent === 'string') {
    props.push({ id: PR_CLIENT_SUBMIT_TIME, value: sent });
  }

  return props;
}

/**
 * Extracts the parentFolderId from a decrypted Graph message JSON.
 * Used as fallback when ManifestEntry.folder_id is not populated (legacy manifests).
 */
export function extract_folder_id_from_json(message_json: Record<string, unknown>): string {
  return (message_json['parentFolderId'] as string) ?? '__unknown__';
}
