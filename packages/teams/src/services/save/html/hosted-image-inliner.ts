import {
  hosted_id_after,
  hosted_path_prefix,
  type HostedOwner,
} from '@/services/backup/hosted-reference-scanner';

/** Result of inlining: the rewritten HTML and how many images were inlined. */
export interface InlinedImages {
  readonly html: string;
  readonly inlined: number;
}

/**
 * Matches one sanitized `<img>` tag. Sanitized attribute values escape `>`, so the tag ends at
 * the first `>`.
 */
const IMG_TAG_RE = /<img\b[^>]*>/g;
const SRC_ATTRIBUTE_RE = /\ssrc="([^"]*)"/;

/**
 * Replaces each `<img src>` that points at one of this message's hosted images with the data URI
 * `data_uris` holds for that image, so the saved page shows it offline. An image with no entry
 * keeps its source; the export reports why when it writes the map.
 */
export function inline_hosted_images(
  html: string,
  owner: HostedOwner,
  data_uris: ReadonlyMap<string, string>,
): InlinedImages {
  const prefix = hosted_path_prefix(owner);
  let inlined = 0;
  let output = '';
  let cursor = 0;
  for (const match of html.matchAll(IMG_TAG_RE)) {
    const start = match.index ?? 0;
    output += html.slice(cursor, start);
    const tag = inline_tag(match[0], prefix, data_uris);
    if (tag !== match[0]) inlined++;
    output += tag;
    cursor = start + match[0].length;
  }
  return { html: output + html.slice(cursor), inlined };
}

function inline_tag(tag: string, prefix: string, data_uris: ReadonlyMap<string, string>): string {
  const src = SRC_ATTRIBUTE_RE.exec(tag);
  if (src === null) return tag;
  const id = hosted_id_after(unescape_attribute(src[1] ?? ''), prefix);
  const data_uri = id === undefined ? undefined : data_uris.get(id);
  if (data_uri === undefined) return tag;
  return tag.slice(0, src.index) + ` src="${data_uri}"` + tag.slice(src.index + src[0].length);
}

/** Reverses the escaping `escape_html` applies to attribute values. */
function unescape_attribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
