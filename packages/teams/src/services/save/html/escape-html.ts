const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes the characters that can open markup or end an attribute value. */
export function escape_html(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}
