import { describe, expect, it } from 'vitest';
import type { TeamsThread } from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { load_saved_thread } from '@/services/save/thread-views';
import {
  message_ref,
  put_blob,
  put_message,
  stub_save_context,
  thread_context,
  TIMESTAMP,
} from './save-harness';

function html_body(text: string) {
  return { contentType: 'html', content: text };
}

describe('load_saved_thread', () => {
  it('shows the kept version of a deleted message, marked as deleted', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const kept = put_message(bucket, store, 'kept-1', {
      id: 'root-1',
      createdDateTime: TIMESTAMP,
      body: html_body('<p>last live text</p>'),
    });
    const tombstone = put_message(bucket, store, 'tomb-1', {
      id: 'root-1',
      createdDateTime: TIMESTAMP,
      body: html_body('<p>tombstone</p>'),
    });
    const thread: TeamsThread = {
      root: message_ref(tombstone, {
        deleted_at: '2025-02-01T00:00:00.000Z',
        kept: { ...kept, hosted: {} },
      }),
      replies: {},
    };
    const { context, tally } = thread_context(ctx);

    const saved = await load_saved_thread(context, 'root-1', thread);

    expect(saved?.root.kept_version).toBe(true);
    expect(saved?.root.deleted_at).toBe('2025-02-01T00:00:00.000Z');
    expect(saved?.root.html).toContain('last live text');
    expect(saved?.root.html).not.toContain('tombstone');
    expect(tally.errors).toEqual([]);
  });

  it('falls back to the tombstone when a deleted message has no kept version', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const tomb = put_message(bucket, store, 'tomb-2', {
      id: 'root-2',
      createdDateTime: TIMESTAMP,
      body: html_body(''),
    });
    const thread: TeamsThread = {
      root: message_ref(tomb, { deleted_at: '2025-02-01T00:00:00.000Z' }),
      replies: {},
    };

    const saved = await load_saved_thread(thread_context(ctx).context, 'root-2', thread);

    expect(saved?.root.kept_version).toBe(false);
    expect(saved?.root.deleted_at).toBe('2025-02-01T00:00:00.000Z');
  });

  it('drops a thread whose root blob is missing and reports it without throwing', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const missing = put_message(bucket, store, 'gone', {
      id: 'root-3',
      createdDateTime: TIMESTAMP,
      body: html_body('x'),
    });
    bucket.delete('gone');
    const thread: TeamsThread = { root: message_ref(missing), replies: {} };
    const { context, tally } = thread_context(ctx);

    const saved = await load_saved_thread(context, 'root-3', thread);

    expect(saved).toBeUndefined();
    expect(tally.errors).toHaveLength(1);
    expect(tally.errors[0]).toContain('message root-3');
  });

  it('skips an unreadable reply, keeps the root and other replies, and reports it', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const root = put_message(bucket, store, 'root', {
      id: 'root-4',
      createdDateTime: '2025-01-01T00:00:00.000Z',
      body: html_body('<p>root</p>'),
    });
    const later = put_message(bucket, store, 'later', {
      id: 'reply-b',
      createdDateTime: '2025-01-03T00:00:00.000Z',
      body: html_body('<p>later</p>'),
    });
    const earlier = put_message(bucket, store, 'earlier', {
      id: 'reply-a',
      createdDateTime: '2025-01-02T00:00:00.000Z',
      body: html_body('<p>earlier</p>'),
    });
    bucket.delete('broken');
    const thread: TeamsThread = {
      root: message_ref(root),
      replies: {
        'reply-b': message_ref(later),
        'reply-broken': message_ref({ storage_key: 'broken', checksum: 'x', size_bytes: 1 }),
        'reply-a': message_ref(earlier),
      },
    };
    const { context, tally } = thread_context(ctx);

    const saved = await load_saved_thread(context, 'root-4', thread);

    expect(saved?.replies.map((reply) => reply.id)).toEqual(['reply-a', 'reply-b']);
    expect(tally.errors).toHaveLength(1);
    expect(tally.errors[0]).toContain('reply reply-broken');
    expect(tally.messages_saved).toBe(3);
  });

  it('escapes a plain-text body so markup in it cannot become HTML', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const plain = put_message(bucket, store, 'plain', {
      id: 'root-5',
      createdDateTime: TIMESTAMP,
      from: { user: { displayName: 'Display Name' } },
      body: { contentType: 'text', content: '<img src=x onerror=alert(1)>' },
    });
    const thread: TeamsThread = { root: message_ref(plain), replies: {} };

    const saved = await load_saved_thread(thread_context(ctx).context, 'root-5', thread);

    expect(saved?.root.author).toBe('Display Name');
    expect(saved?.root.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(saved?.root.html).not.toContain('<img');
  });

  it('writes a hosted object of an attachment, which the body never shows, and lists what is missing', async () => {
    const store = stub_encrypted_object_store();
    const bucket = new Map<string, Buffer>();
    const ctx = stub_save_context(store, bucket);
    const snippet = put_blob(bucket, store, 'snippet', 'code');
    const message = put_message(bucket, store, 'msg', {
      id: 'root-6',
      createdDateTime: TIMESTAMP,
      body: html_body('<p>see attachment</p>'),
    });
    const thread: TeamsThread = {
      root: message_ref(message, {
        hosted: { s1: { ...snippet, content_type: 'text/plain' } },
        hosted_missing: ['s2'],
      }),
      replies: {},
    };
    const { context, tally, entries } = thread_context(ctx, 'channels/C');

    const saved = await load_saved_thread(context, 'root-6', thread);

    expect(saved?.root.hosted).toEqual([
      { id: 's1', content_type: 'text/plain', path: 'channels/C/hosted/root-6/s1.txt' },
    ]);
    expect(saved?.root.hosted_missing).toEqual(['s2']);
    expect(entries.has('channels/C/hosted/root-6/s1.txt')).toBe(true);
    expect(tally.hosted_missing).toHaveLength(1);
  });
});
