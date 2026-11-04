import type { TeamsHostedRef } from '@wisecom/atlas-types';
import { error_message } from '@/services/shared/error-message';
import {
  hosted_id_after,
  hosted_path_prefix,
  type HostedOwner,
} from '@/services/backup/hosted-reference-scanner';

/** Result of inlining: the rewritten HTML, how many images were inlined, and non-fatal failures. */
export interface InlinedImages {
  readonly html: string;
  readonly inlined: number;
  readonly errors: string[];
}

/**
 * Matches one sanitized `<img>` tag. Sanitized attribute values escape `>`, so the tag ends at
 * the first `>`.
 */
const IMG_TAG_RE = /<img\b[^>]*>/g;
const SRC_ATTRIBUTE_RE = /\ssrc="([^"]*)"/;
const IMAGE_TYPE_RE = /^image\/[a-z0-9.+-]+$/i;

/**
 * Replaces each `<img src>` that points at one of this message's hosted contents with a `data:`
 * URI, so the saved page shows the image offline. `load` returns the data URI for one reference
 * and throws when the blob is missing or damaged; that image keeps its source and is reported.
 */
export async function inline_hosted_images(
  html: string,
  owner: HostedOwner,
  hosted: Record<string, TeamsHostedRef>,
  load: (ref: TeamsHostedRef) => Promise<string>,
): Promise<InlinedImages> {
  const prefix = hosted_path_prefix(owner);
  const errors: string[] = [];
  let inlined = 0;
  let output = '';
  let cursor = 0;
  for (const match of html.matchAll(IMG_TAG_RE)) {
    const start = match.index ?? 0;
    output += html.slice(cursor, start);
    const tag = await inline_tag(match[0], prefix, hosted, load, errors);
    if (tag !== match[0]) inlined++;
    output += tag;
    cursor = start + match[0].length;
  }
  return { html: output + html.slice(cursor), inlined, errors };
}

async function inline_tag(
  tag: string,
  prefix: string,
  hosted: Record<string, TeamsHostedRef>,
  load: (ref: TeamsHostedRef) => Promise<string>,
  errors: string[],
): Promise<string> {
  const src = SRC_ATTRIBUTE_RE.exec(tag);
  if (src === null) return tag;
  const id = hosted_id_after(unescape_attribute(src[1] ?? ''), prefix);
  const ref = id === undefined ? undefined : hosted[id];
  if (ref === undefined || !IMAGE_TYPE_RE.test(ref.content_type ?? '')) return tag;
  try {
    const data_uri = await load(ref);
    return tag.slice(0, src.index) + ` src="${data_uri}"` + tag.slice(src.index + src[0].length);
  } catch (err) {
    errors.push(`hosted image ${id}: ${error_message(err)}`);
    return tag;
  }
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
