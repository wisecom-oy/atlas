import { describe, expect, it, vi } from 'vitest';
import type { TeamsHostedRef } from '@wisecom/atlas-types';
import { inline_hosted_images } from '@/services/save/html/hosted-image-inliner';

const OWNER = { root_id: 'root-1' };
const PREFIX = '/messages/root-1/hostedContents/';

function hosted(content_type: string): TeamsHostedRef {
  return { storage_key: 'k', checksum: 'c', size_bytes: 3, content_type };
}

describe('inline_hosted_images', () => {
  it('replaces a hosted image source with the data URI returned by the loader', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAAA');
    const html = `<p><img src="https://graph.test${PREFIX}h1/$value" alt="a"></p>`;

    const out = await inline_hosted_images(html, OWNER, { h1: hosted('image/png') }, load);

    expect(out.html).toBe('<p><img src="data:image/png;base64,AAAA" alt="a"></p>');
    expect(out.inlined).toBe(1);
    expect(out.errors).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('leaves non-image hosted contents and unknown ids untouched', async () => {
    const load = vi.fn(async () => 'data:x;base64,AA');
    const html = `<img src="${PREFIX}doc/$value">` + `<img src="${PREFIX}missing/$value">`;

    const out = await inline_hosted_images(html, OWNER, { doc: hosted('application/pdf') }, load);

    expect(out.html).toBe(html);
    expect(out.inlined).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the original source and reports the error when a blob cannot be read', async () => {
    const load = vi.fn(async () => {
      throw new Error('blob is missing from storage');
    });
    const html = `<img src="${PREFIX}h1/$value">`;

    const out = await inline_hosted_images(html, OWNER, { h1: hosted('image/jpeg') }, load);

    expect(out.html).toBe(html);
    expect(out.inlined).toBe(0);
    expect(out.errors).toEqual(['hosted image h1: blob is missing from storage']);
  });

  it('does not inline a reply image under the root message path', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AA');
    const html = `<img src="${PREFIX}h1/$value">`;

    const out = await inline_hosted_images(
      html,
      { root_id: 'root-1', reply_id: 'reply-9' },
      { h1: hosted('image/png') },
      load,
    );

    expect(out.html).toBe(html);
    expect(load).not.toHaveBeenCalled();
  });
});
