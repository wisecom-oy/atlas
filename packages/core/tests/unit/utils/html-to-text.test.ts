import { describe, expect, it } from 'vitest';
import { html_to_text } from '@/utils/html-to-text';

describe('html_to_text', () => {
  it('strips basic HTML tags and returns text content', () => {
    expect(html_to_text('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes script blocks including their content', () => {
    const html = '<p>safe</p><script>alert("xss")</script><p>also safe</p>';
    expect(html_to_text(html)).toBe('safealso safe');
  });

  it('removes style blocks including their content', () => {
    const html = '<style>.red { color: red; }</style><p>visible</p>';
    expect(html_to_text(html)).toBe('visible');
  });

  it('removes head blocks including their content', () => {
    const html = '<head><title>ignored</title></head><body>visible</body>';
    expect(html_to_text(html)).toBe('visible');
  });

  it('handles nested script tags without leaking content', () => {
    const html = '<div>ok</div><script type="text/javascript">var x = 1;</script><div>end</div>';
    expect(html_to_text(html)).toBe('okend');
  });

  it('handles malformed script tag with spaces before closing bracket', () => {
    const html = '<p>before</p><script >evil()</script ><p>after</p>';
    expect(html_to_text(html)).toBe('beforeafter');
  });

  it('decodes &amp; entity correctly', () => {
    expect(html_to_text('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });

  it('decodes &lt; and &gt; entities', () => {
    expect(html_to_text('1 &lt; 2 &gt; 0')).toBe('1 < 2 > 0');
  });

  it('decodes &quot; and &#39; entities', () => {
    expect(html_to_text('&quot;hello&quot; &#39;world&#39;')).toBe('"hello" \'world\'');
  });

  it('decodes &nbsp; to space', () => {
    expect(html_to_text('word1&nbsp;word2')).toBe('word1\u00a0word2');
  });

  it('decodes numeric entities', () => {
    expect(html_to_text('&#60;tag&#62;')).toBe('<tag>');
  });

  it('decodes hex entities', () => {
    expect(html_to_text('&#x3c;tag&#x3e;')).toBe('<tag>');
  });

  it('does not double-unescape &amp;lt; into <', () => {
    const result = html_to_text('&amp;lt;script&amp;gt;');
    expect(result).toBe('&lt;script&gt;');
  });

  it('decodes entity-encoded angle brackets to literal characters in text', () => {
    const html = '&lt;script&gt;alert(1)&lt;/script&gt;';
    const result = html_to_text(html);
    expect(result).toBe('<script>alert(1)</script>');
  });

  it('handles attributes with > inside quoted values', () => {
    const html = '<a title="click > here">link</a>';
    expect(html_to_text(html)).toBe('link');
  });

  it('collapses excessive newlines to double newline', () => {
    const html = '<p>a</p>\n\n\n\n<p>b</p>';
    expect(html_to_text(html)).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(html_to_text('  <p>text</p>  ')).toBe('text');
  });

  it('returns empty string for empty input', () => {
    expect(html_to_text('')).toBe('');
  });

  it('returns empty string for whitespace-only HTML', () => {
    expect(html_to_text('   \n\n  ')).toBe('');
  });

  it('handles a realistic email body', () => {
    const html = `
      <html>
        <head><style>body { font: sans-serif; }</style></head>
        <body>
          <p>Hi,</p>
          <p>Please see the <b>attached</b> report.</p>
          <p>Thanks &amp; regards,<br/>Alice</p>
        </body>
      </html>
    `;
    const result = html_to_text(html);
    expect(result).toContain('Hi,');
    expect(result).toContain('attached');
    expect(result).toContain('Thanks & regards,');
    expect(result).toContain('Alice');
    expect(result).not.toContain('<');
    expect(result).not.toContain('font');
  });
});
