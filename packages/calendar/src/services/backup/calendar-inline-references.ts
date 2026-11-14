import type { GraphEventAttachment, GraphEventPayload } from '@wisecom/atlas-types';
import { is_record } from '@/services/shared/json-record';

/**
 * A `cid:` URL where HTML loads an image from it: a `src` or `background` attribute, or a CSS
 * `url()`. A `cid:` that only appears in the text of the description is not a reference.
 */
const CID_REFERENCE =
  /(?:\b(?:src|background)\s*=\s*["']?\s*|url\(\s*["']?\s*)cid:([^"'\s<>()]+)/gi;

/** Content IDs compare without the angle brackets a `Content-ID` header carries, ignoring case. */
function normalize_content_id(content_id: string): string {
  return content_id.replace(/^<|>$/g, '').toLowerCase();
}

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
  const carried = new Set(
    listed.flatMap((attachment) =>
      attachment.content_id === undefined ? [] : [normalize_content_id(attachment.content_id)],
    ),
  );
  return references.filter((content_id) => !carried.has(normalize_content_id(content_id)));
}
