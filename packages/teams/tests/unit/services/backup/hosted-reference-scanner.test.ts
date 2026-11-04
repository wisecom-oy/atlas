import { describe, expect, it } from 'vitest';
import { referenced_hosted_ids } from '@/services/backup/hosted-reference-scanner';

describe('referenced_hosted_ids', () => {
  it('finds an id referenced by a plain body URL', () => {
    const ids = referenced_hosted_ids({
      id: 'm1',
      body: { content: '<img src="https://g/hostedContents/h1/$value">' },
    });

    expect(ids).toEqual(['h1']);
  });

  it('finds an id whose slashes are HTML entities in the body', () => {
    const ids = referenced_hosted_ids({
      id: 'm1',
      body: { content: '<img src="https://g/hostedContents&#47;h2&sol;$value">' },
    });

    expect(ids).toEqual(['h2']);
  });

  it('finds an id whose slashes are JSON-escaped in an attachment', () => {
    const ids = referenced_hosted_ids({
      id: 'm1',
      body: { content: '' },
      attachments: [{ content: '{"url":"https://g/hostedContents\\/h3\\/$value"}' }],
    });

    expect(ids).toEqual(['h3']);
  });

  it('decodes a percent-encoded id', () => {
    const ids = referenced_hosted_ids({
      id: 'm1',
      body: { content: '<img src="https://g/hostedContents/a%2Bb/$value">' },
    });

    expect(ids).toEqual(['a+b']);
  });

  it('returns nothing when the message references no hosted content', () => {
    expect(referenced_hosted_ids({ id: 'm1', body: { content: 'plain text' } })).toEqual([]);
  });

  it('ignores a hosted-content path written as plain text', () => {
    const ids = referenced_hosted_ids({
      id: 'm1',
      body: { content: 'see hostedContents/abc/$value' },
    });

    expect(ids).toEqual([]);
  });

  it('keeps an encoded slash inside the id', () => {
    const ids = referenced_hosted_ids({
      id: 'm1',
      body: { content: '<img src="https://g/hostedContents/a%2Fb/$value">' },
    });

    expect(ids).toEqual(['a/b']);
  });
});
