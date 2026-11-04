import type { TeamsGraphResource } from '@wisecom/atlas-types';

/** The message whose hosted contents are scanned: a root, or one reply inside it. */
export interface HostedOwner {
  readonly root_id: string;
  readonly reply_id?: string | undefined;
}

/** Any `name="value"` or `name":"value"` pair, with JSON or HTML quoting around the value. */
const ATTRIBUTE_VALUE_RE = /([A-Za-z_][\w-]*)\\?"?\s*[=:]\s*\\?["']([^"'\\<>\s]*)/g;

/** Attribute names that carry a URL: `src`, `url`, any suffix of those, and `backgroundImage`. */
const URL_ATTRIBUTE_RE = /(?:src|url)$|^backgroundimage$/i;

/**
 * Returns the hosted-content ids that a message's body and attachments reference through a URL
 * attribute and that point at this message's own `hostedContents` path. Plain text and other
 * messages' images do not count. Graph escapes references differently per field: JSON-escaped
 * slashes inside card content, HTML entities in the body, and percent-encoding in the id.
 */
export function referenced_hosted_ids(message: TeamsGraphResource, owner: HostedOwner): string[] {
  const prefix = hosted_path_prefix(owner);
  const text = unescape_reference_text(
    JSON.stringify({ body: message.body, attachments: message.attachments }),
  );
  const ids = new Set<string>();
  for (const match of text.matchAll(ATTRIBUTE_VALUE_RE)) {
    const [, name = '', value = ''] = match;
    const id = URL_ATTRIBUTE_RE.test(name) ? hosted_id_after(value, prefix) : undefined;
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** The path that names this message's hosted contents, with the hosted-content id still to come. */
function hosted_path_prefix(owner: HostedOwner): string {
  return owner.reply_id === undefined
    ? `/messages/${owner.root_id}/hostedContents/`
    : `/messages/${owner.root_id}/replies/${owner.reply_id}/hostedContents/`;
}

function hosted_id_after(value: string, prefix: string): string | undefined {
  const index = value.indexOf(prefix);
  if (index < 0) {
    return undefined;
  }
  const segment = /^[^/?#]+/.exec(value.slice(index + prefix.length))?.[0];
  return segment === undefined ? undefined : decode_segment(segment);
}

function unescape_reference_text(text: string): string {
  return text
    .replace(/\\+\//g, '/')
    .replace(/&(?:sol|#47|#x2f);/gi, '/')
    .replace(/&amp;/gi, '&');
}

function decode_segment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
