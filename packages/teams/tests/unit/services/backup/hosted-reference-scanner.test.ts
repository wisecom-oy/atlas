import { describe, expect, it } from 'vitest';
import { referenced_hosted_ids } from '@/services/backup/hosted-reference-scanner';

const ROOT = { root_id: 'root-1' };
const REPLY = { root_id: 'root-1', reply_id: 'reply-1' };
const ROOT_IMG = (id: string) =>
  `<img src="https://g/messages/root-1/hostedContents/${id}/$value">`;

describe('referenced_hosted_ids', () => {
  it('finds an id referenced by a plain body src', () => {
    const message = { id: 'root-1', body: { content: ROOT_IMG('h1') } };

    expect(referenced_hosted_ids(message, ROOT)).toEqual(['h1']);
  });

  it('finds an id whose slashes are HTML entities in the body', () => {
    const message = {
      id: 'root-1',
      body: {
        content: '<img src="https://g/messages/root-1&#47;hostedContents&sol;h2&#x2F;$value">',
      },
    };

    expect(referenced_hosted_ids(message, ROOT)).toEqual(['h2']);
  });

  it('finds an id whose slashes are JSON-escaped in an attachment codeSnippetUrl', () => {
    const message = {
      id: 'root-1',
      body: { content: '' },
      attachments: [
        {
          content:
            '{"codeSnippetUrl":"https://g/messages\\/root-1\\/hostedContents\\/h3\\/$value"}',
        },
      ],
    };

    expect(referenced_hosted_ids(message, ROOT)).toEqual(['h3']);
  });

  it('finds an id in a backgroundImage card property', () => {
    const message = {
      id: 'root-1',
      body: { content: '' },
      attachments: [
        {
          content: '{"backgroundImage":"https://g/messages/root-1/hostedContents/h4/$value"}',
        },
      ],
    };

    expect(referenced_hosted_ids(message, ROOT)).toEqual(['h4']);
  });

  it('decodes a percent-encoded hosted id', () => {
    const message = {
      id: 'root-1',
      body: { content: '<img src="https://g/messages/root-1/hostedContents/abc%3D/$value">' },
    };

    expect(referenced_hosted_ids(message, ROOT)).toEqual(['abc=']);
  });

  it('ignores another message’s hosted content', () => {
    const message = {
      id: 'root-1',
      body: { content: '<img src="https://g/messages/root-2/hostedContents/h9/$value">' },
    };

    expect(referenced_hosted_ids(message, ROOT)).toEqual([]);
  });

  it('ignores a hosted path that appears as plain text rather than a URL attribute', () => {
    const message = {
      id: 'root-1',
      body: { content: 'see messages/root-1/hostedContents/h1/$value' },
    };

    expect(referenced_hosted_ids(message, ROOT)).toEqual([]);
  });

  it('matches a reply only against the reply path, not the root path', () => {
    const message = {
      id: 'reply-1',
      body: {
        content:
          '<img src="https://g/messages/root-1/replies/reply-1/hostedContents/h5/$value">' +
          '<img src="https://g/messages/root-1/hostedContents/h6/$value">',
      },
    };

    expect(referenced_hosted_ids(message, REPLY)).toEqual(['h5']);
  });

  it('returns each id once even when referenced twice', () => {
    const message = { id: 'root-1', body: { content: ROOT_IMG('h7') + ROOT_IMG('h7') } };

    expect(referenced_hosted_ids(message, ROOT)).toEqual(['h7']);
  });
});
