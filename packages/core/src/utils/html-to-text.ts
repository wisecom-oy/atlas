import { Parser } from 'htmlparser2';

const SKIP_TAGS = new Set(['script', 'style', 'head']);

/** Converts HTML to plain text using a proper parser, skipping script/style/head content. */
export function html_to_text(html: string): string {
  const chunks: string[] = [];
  let skip_depth = 0;

  const parser = new Parser(
    {
      onopentag(name): void {
        if (SKIP_TAGS.has(name.toLowerCase())) skip_depth++;
      },
      ontext(text): void {
        if (skip_depth === 0) chunks.push(text);
      },
      onclosetag(name): void {
        if (SKIP_TAGS.has(name.toLowerCase())) skip_depth = Math.max(0, skip_depth - 1);
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();

  return chunks
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
