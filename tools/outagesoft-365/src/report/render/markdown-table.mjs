/**
 * GitHub-flavoured Markdown tables with escaping and a row cap.
 *
 * Cell text can come from the journal (templated URLs, Graph error codes), so pipes, backticks and
 * angle brackets are escaped before they reach a table. Long tables stop at a limit and end with a
 * line saying how many rows report.json still holds.
 */

function escape_plain(text) {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Escapes text for a table cell. Code spans written by the report (`like this`) are kept: inside
 * them only the pipe is escaped, because an entity there would render literally.
 */
export function escape_cell(value) {
  return String(value ?? '')
    .replaceAll('\n', ' ')
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part.replaceAll('|', '\\|') : escape_plain(part)))
    .join('');
}

/** Wraps text in a code span that survives backticks inside it, escaped for a table cell. */
export function code(value) {
  const text = String(value ?? '').replaceAll('|', '\\|');
  const fence = text.includes('`') ? '``' : '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Renders a table. `rows` holds arrays of already formatted cells; pass raw strings through
 * `escape_cell` or `code` first. Rows beyond `limit` are summarised in one trailing line.
 */
export function render_table(headers, rows, { limit = Infinity, align = [], noun = 'rows' } = {}) {
  if (!rows.length) return '_None._\n';
  const shown = rows.slice(0, limit);
  const separator = headers.map((_, i) => (align[i] === 'right' ? '---:' : '---'));
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...shown.map((r) => `| ${r.join(' | ')} |`),
  ];
  if (rows.length > shown.length) {
    lines.push('', `_And ${rows.length - shown.length} more ${noun} in report.json._`);
  }
  return `${lines.join('\n')}\n`;
}
