import { Parser } from 'htmlparser2';
import { escape_html } from '@/services/save/html/escape-html';

/**
 * Elements that keep their tag. Anything else is dropped and its text kept, so an unknown
 * container never hides a message's words. An allowlist, not a denylist: a new HTML element
 * is dropped until someone decides it is safe.
 */
const KEPT_TAGS: Record<string, true> = {
  a: true,
  abbr: true,
  b: true,
  blockquote: true,
  br: true,
  caption: true,
  cite: true,
  code: true,
  col: true,
  colgroup: true,
  dd: true,
  del: true,
  div: true,
  dl: true,
  dt: true,
  em: true,
  figcaption: true,
  figure: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  hr: true,
  i: true,
  img: true,
  ins: true,
  kbd: true,
  li: true,
  mark: true,
  ol: true,
  p: true,
  pre: true,
  q: true,
  s: true,
  small: true,
  span: true,
  strong: true,
  sub: true,
  sup: true,
  table: true,
  tbody: true,
  td: true,
  tfoot: true,
  th: true,
  thead: true,
  tr: true,
  u: true,
  ul: true,
};

/**
 * Elements dropped together with everything inside them, because their text is not message
 * text.
 */
const DROPPED_WITH_CONTENT: Record<string, true> = {
  iframe: true,
  noscript: true,
  object: true,
  script: true,
  select: true,
  style: true,
  template: true,
  textarea: true,
  title: true,
};

/** The only void elements in KEPT_TAGS: they never get a closing tag. */
const VOID_TAGS: Record<string, true> = { br: true, col: true, hr: true, img: true };

/** Attributes kept per element. Event handlers, `style`, and `class` are never listed. */
const KEPT_ATTRIBUTES: Record<string, true> = {
  align: true,
  alt: true,
  colspan: true,
  dir: true,
  height: true,
  href: true,
  lang: true,
  rowspan: true,
  src: true,
  title: true,
  width: true,
};

/**
 * Keeps only the allowlisted markup of a Teams message body and re-serializes it. Attribute values
 * are re-escaped and URLs are limited to http(s) and mailto, so `javascript:` never survives. The
 * page's CSP (see the channel page) is the second line of defence, not the first.
 */
export function sanitize_message_html(html: string): string {
  let output = '';
  let dropped_depth = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs): void {
        if (DROPPED_WITH_CONTENT[name] === true) {
          dropped_depth++;
        } else if (dropped_depth === 0 && KEPT_TAGS[name] === true) {
          output += `<${name}${render_attributes(attribs)}>`;
        }
      },
      ontext(text): void {
        if (dropped_depth === 0) output += escape_html(text);
      },
      onclosetag(name): void {
        if (DROPPED_WITH_CONTENT[name] === true) {
          dropped_depth = Math.max(0, dropped_depth - 1);
        } else if (dropped_depth === 0 && KEPT_TAGS[name] === true && VOID_TAGS[name] !== true) {
          output += `</${name}>`;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return output;
}

function render_attributes(attribs: Record<string, string>): string {
  return Object.entries(attribs)
    .filter(([key, value]) => KEPT_ATTRIBUTES[key] === true && is_allowed_attribute(key, value))
    .map(([key, value]) => ` ${key}="${escape_html(value)}"`)
    .join('');
}

function is_allowed_attribute(key: string, value: string): boolean {
  if (key === 'href') return /^(https?:|mailto:)/i.test(value.trim());
  if (key === 'src') return /^https?:/i.test(value.trim());
  return true;
}
