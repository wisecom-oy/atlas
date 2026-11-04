import type { TeamsGraphResource } from '@wisecom/atlas-types';

/** A hosted-content id is the path segment after `hostedContents/`. */
const HOSTED_REFERENCE_RE = /hostedContents\/([^/"'\s<>?#&\\]+)/g;

/**
 * Returns the hosted-content ids a message's body and attachments reference. Graph escapes these
 * references differently per field: JSON-escaped slashes (`\/`) inside attachment content, HTML
 * entities (`&sol;`, `&#47;`, `&#x2F;`) in the body, and percent-encoding in the id itself.
 */
export function referenced_hosted_ids(message: TeamsGraphResource): string[] {
  const serialized = JSON.stringify({ body: message.body, attachments: message.attachments });
  const text = unescape_reference_text(serialized);
  const ids = new Set<string>();
  for (const match of text.matchAll(HOSTED_REFERENCE_RE)) {
    ids.add(decode_segment(match[1] ?? ''));
  }
  return [...ids].filter((id) => id.length > 0);
}

function unescape_reference_text(text: string): string {
  return text
    .replace(/\\+\//g, '/')
    .replace(/&(?:sol|#47|#x2f);/gi, '/')
    .replace(/&amp;/gi, '&')
    .replace(/%2F/gi, '/');
}

function decode_segment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
