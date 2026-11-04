import { describe, expect, it } from 'vitest';
import { sanitize_message_html } from '@/services/save/html/sanitize-message-html';

describe('sanitize_message_html', () => {
  it('drops script, event handlers, meta, base, iframe and form from a message body', () => {
    const html =
      '<p onclick="steal()">hi</p><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(2)">' +
      '<meta http-equiv="refresh" content="0;url=https://x.test"><base href="https://x.test/">' +
      '<iframe src="https://x.test/frame"></iframe><form action="https://x.test"><input name="q"></form>';

    const out = sanitize_message_html(html);

    expect(out).toContain('<p>hi</p>');
    expect(out).not.toMatch(/<script|onclick|onerror|<meta|<base|<iframe|<form|<input/i);
    expect(out).not.toContain('alert(');
    expect(out).not.toContain('steal()');
  });

  it('removes the content of dropped containers, not only their tags', () => {
    const out = sanitize_message_html('<p>keep</p><script>payload()</script><style>p{}</style>');

    expect(out).toBe('<p>keep</p>');
  });

  it('keeps https links and drops javascript: links', () => {
    const out = sanitize_message_html(
      '<a href="https://example.test/doc">doc</a> <a href="javascript:alert(1)">bad</a>',
    );

    expect(out).toContain('href="https://example.test/doc"');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('bad');
  });

  it('does not let an image point at a non-http source', () => {
    const out = sanitize_message_html('<img src="file:///etc/passwd" alt="x">');

    expect(out).not.toContain('file:');
  });

  it('re-escapes text so markup in plain text cannot form a tag', () => {
    const out = sanitize_message_html('<p>1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;</p>');

    expect(out).toContain('1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;');
    expect(out).not.toContain('<b>');
  });
});
