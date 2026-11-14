import type { GraphEventAttachment, GraphEventPayload } from '@wisecom/atlas-types';
import { is_record } from '@/services/shared/json-record';

/** A `cid:` URL in an HTML attribute, up to the closing quote, whitespace or tag end. */
const CID_REFERENCE = /cid:([^"'\s<>()]+)/gi;

/**
 * The content IDs an event body references as inline images, each once. Graph returns the body
 * as HTML unless asked for text, and a text body cannot embed an image, so it is not scanned.
 */
export function body_inline_references(payload: GraphEventPayload): string[] {
  const body = payload['body'];
  if (!is_record(body) || body['contentType'] === 'text') return [];
  const content = body['content'];
  if (typeof content !== 'string') return [];
  const ids = [...content.matchAll(CID_REFERENCE)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id !== ''))];
}

/**
 * Whether the event's attachments must be listed. Graph reports `hasAttachments: false` for an
 * event whose only attachments are inline, so a `cid:` reference in the body also triggers it.
 */
export function needs_attachment_listing(
  payload: GraphEventPayload,
  references: readonly string[],
): boolean {
  return payload['hasAttachments'] === true || references.length > 0;
}

/** The referenced content IDs that none of the listed attachments carries. */
export function unresolved_inline_references(
  references: readonly string[],
  listed: readonly GraphEventAttachment[],
): string[] {
  const carried = new Set(listed.map((attachment) => attachment.content_id));
  return references.filter((content_id) => !carried.has(content_id));
}
