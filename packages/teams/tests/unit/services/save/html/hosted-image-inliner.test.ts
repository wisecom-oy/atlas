import { describe, expect, it } from 'vitest';
import { inline_hosted_images } from '@/services/save/html/hosted-image-inliner';

const OWNER = { root_id: 'root-1' };
const PREFIX = '/messages/root-1/hostedContents/';
const PNG_URI = 'data:image/png;base64,AAAA';

describe('inline_hosted_images', () => {
  it('replaces a hosted image source with its data URI', () => {
    const html = `<p><img src="https://graph.test${PREFIX}h1/$value" alt="a"></p>`;

    const out = inline_hosted_images(html, OWNER, new Map([['h1', PNG_URI]]));

    expect(out.html).toBe(`<p><img src="${PNG_URI}" alt="a"></p>`);
    expect(out.inlined).toBe(1);
  });

  it('leaves an image with no data URI, and any other source, untouched', () => {
    const html = `<img src="${PREFIX}doc/$value">` + `<img src="${PREFIX}missing/$value">`;

    const out = inline_hosted_images(html, OWNER, new Map([['other', PNG_URI]]));

    expect(out.html).toBe(html);
    expect(out.inlined).toBe(0);
  });

  it('does not inline a reply image under the root message path', () => {
    const html = `<img src="${PREFIX}h1/$value">`;

    const out = inline_hosted_images(
      html,
      { root_id: 'root-1', reply_id: 'reply-9' },
      new Map([['h1', PNG_URI]]),
    );

    expect(out.html).toBe(html);
    expect(out.inlined).toBe(0);
  });
});
