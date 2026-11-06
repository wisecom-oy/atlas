import { escape_html } from '@/services/save/html/escape-html';
import type { SavedMessage, SavedThread } from '@/services/save/thread-views';

/**
 * Saved pages run with no script, no remote fetch, and no frames. Images load only from the
 * `data:` URIs written at export time; styles are inline because the page carries its own.
 */
const CONTENT_SECURITY_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const PAGE_STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
article { border-left: 3px solid #ccc; padding: 0.25rem 1rem; margin: 0.75rem 0; }
article.reply { margin-left: 2rem; }
.meta { color: #666; font-size: 0.9rem; }
.deleted { color: #a00; font-weight: 600; }
.plain { white-space: pre-wrap; }
img { max-width: 100%; }`;

/** Renders one channel's threads as a self-contained HTML page. */
export function render_channel_page(title: string, threads: SavedThread[]): string {
  const escaped_title = escape_html(title);
  const body = threads.map(render_thread).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<title>${escaped_title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>${escaped_title}</h1>
${body}
</body>
</html>
`;
}

function render_thread(thread: SavedThread): string {
  const replies = thread.replies.map((reply) => render_message(reply, true));
  const root = render_message(thread.root, false);
  return `<section class="thread">\n${root}\n${replies.join('\n')}\n</section>`;
}

function render_message(message: SavedMessage, is_reply: boolean): string {
  const class_name = is_reply ? 'message reply' : 'message';
  const deleted_text = message.kept_version ? 'Deleted (last version shown)' : 'Deleted';
  const deleted =
    message.deleted_at === undefined ? '' : `<span class="deleted">${deleted_text}</span> `;
  const author = escape_html(message.author || 'Unknown');
  const created = escape_html(message.created_at);
  return `<article class="${class_name}">
<p class="meta">${deleted}<strong>${author}</strong> <time>${created}</time></p>
${message.html}
</article>`;
}
