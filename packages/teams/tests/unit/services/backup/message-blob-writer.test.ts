import { describe, expect, it } from 'vitest';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import { digest_message_blob, strip_volatile_keys } from '@/services/backup/message-blob-writer';
import { make_harness, message } from './thread-store-harness';

/** A root as Graph returns it from GET with `$expand=replies`: annotations and inline replies. */
function root_from_get(): TeamsGraphResource {
  return {
    ...message('root-1'),
    '@odata.etag': 'W/"etag-get"',
    'replies@odata.count': 1,
    replies: [message('reply-1')],
  } as TeamsGraphResource;
}

describe('strip_volatile_keys', () => {
  it('removes @odata annotations and the reply list, and keeps every other key', () => {
    const stripped = strip_volatile_keys({
      id: 'root-1',
      subject: null,
      '@odata.etag': 'W/"x"',
      '@odata.nextLink': 'https://graph.example.test/next',
      'replies@odata.count': 2,
      replies: [],
    } as TeamsGraphResource);

    expect(stripped).toEqual({ id: 'root-1', subject: null });
  });
});

describe('digest_message_blob', () => {
  it('gives a GET and a list read of the same root an identical blob', () => {
    const harness = make_harness();
    const from_list = message('root-1');

    const from_get = digest_message_blob(harness.scope, root_from_get());
    const from_list_digest = digest_message_blob(harness.scope, from_list);

    expect(from_get.storage_key).toBe(from_list_digest.storage_key);
    expect(from_get.checksum).toBe(from_list_digest.checksum);
    expect(from_get.plaintext.equals(from_list_digest.plaintext)).toBe(true);
  });

  it('stores the message without the volatile keys', () => {
    const harness = make_harness();

    const digest = digest_message_blob(harness.scope, root_from_get());

    expect(JSON.parse(digest.plaintext.toString('utf8'))).toEqual(message('root-1'));
  });

  it('still changes the key when the message content changes', () => {
    const harness = make_harness();
    const before = digest_message_blob(harness.scope, message('root-1'));
    const after = digest_message_blob(
      harness.scope,
      message('root-1', { body: { contentType: 'html', content: 'edited' } }),
    );

    expect(after.storage_key).not.toBe(before.storage_key);
  });
});
