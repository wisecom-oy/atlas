import { describe, expect, it } from 'vitest';
import type { TeamsGraphResource, TeamsMessageRef, TeamsThread } from '@wisecom/atlas-types';
import { mark_root_removed, store_thread } from '@/services/backup/thread-store';
import {
  BACKUP_AT,
  DELETED_AT,
  CHANNEL_ID,
  deleted,
  make_harness,
  message,
  type ThreadHarness,
} from './thread-store-harness';

async function store(
  harness: ThreadHarness,
  previous: TeamsThread | undefined,
  root: TeamsGraphResource,
  replies: TeamsGraphResource[],
): Promise<TeamsThread> {
  const result = await store_thread(harness.scope, CHANNEL_ID, previous, root, replies);
  return result.thread;
}

function blob_of(harness: ThreadHarness, ref: TeamsMessageRef): unknown {
  return JSON.parse(harness.objects[ref.storage_key]?.toString('utf8') ?? 'null');
}

describe('store_thread blobs', () => {
  it('writes each message as its own raw Graph JSON blob', async () => {
    const harness = make_harness();
    const root = message('root-1', { body: { contentType: 'html', content: 'parent' } });
    const reply = message('reply-1', { body: { contentType: 'html', content: 'child' } });

    const thread = await store(harness, undefined, root, [reply]);

    expect(blob_of(harness, thread.root)).toEqual(root);
    expect(blob_of(harness, thread.replies['reply-1'] as TeamsMessageRef)).toEqual(reply);
    expect(thread.root.storage_key).not.toBe(thread.replies['reply-1']?.storage_key);
  });
});

describe('store_thread kept model (N9)', () => {
  it('keeps a reply’s last live version when that reply is deleted', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), [message('reply-1')]);
    const live = first.replies['reply-1'] as TeamsMessageRef;

    const second = await store(harness, first, message('root-1'), [deleted('reply-1')]);

    expect(second.replies['reply-1']?.deleted_at).toBe(DELETED_AT);
    expect(second.replies['reply-1']?.kept).toEqual({
      storage_key: live.storage_key,
      checksum: live.checksum,
      size_bytes: live.size_bytes,
      hosted: {},
    });
  });

  it('keeps another reply’s kept version when a sibling reply is deleted later', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), [
      message('reply-1'),
      message('reply-2'),
    ]);
    const second = await store(harness, first, message('root-1'), [
      deleted('reply-1'),
      message('reply-2'),
    ]);
    const kept_reply_1 = second.replies['reply-1']?.kept;

    const third = await store(harness, second, message('root-1'), [
      message('reply-1'),
      deleted('reply-2'),
    ]);

    expect(third.replies['reply-1']?.kept).toEqual(kept_reply_1);
    expect(third.replies['reply-2']?.kept?.storage_key).toBe(
      second.replies['reply-2']?.storage_key,
    );
  });

  it('never replaces a kept version with a later live version', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), [message('reply-1')]);
    const deleted_once = await store(harness, first, message('root-1'), [deleted('reply-1')]);
    const kept = deleted_once.replies['reply-1']?.kept;

    const relive = await store(harness, deleted_once, message('root-1'), [
      message('reply-1', { body: { contentType: 'html', content: 'changed' } }),
    ]);
    const deleted_again = await store(harness, relive, message('root-1'), [deleted('reply-1')]);

    expect(deleted_again.replies['reply-1']?.kept).toEqual(kept);
  });

  it('leaves a message first seen already deleted without a kept version', async () => {
    const harness = make_harness();

    const thread = await store(harness, undefined, message('root-1'), [deleted('reply-1')]);

    expect(thread.replies['reply-1']?.kept).toBeUndefined();
  });

  it('sets the thread deleted_at from the root only', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), [message('reply-1')]);

    const second = await store(harness, first, deleted('root-1'), [message('reply-1')]);

    expect(second.deleted_at).toBe(DELETED_AT);
    expect(second.replies['reply-1']?.deleted_at).toBeUndefined();
  });
});

describe('store_thread reply carry-over', () => {
  it('carries a reply that this run did not list from the previous thread', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), [message('reply-1')]);

    const second = await store(harness, first, message('root-1'), []);

    expect(second.replies['reply-1']).toEqual(first.replies['reply-1']);
  });
});

describe('mark_root_removed', () => {
  it('marks the root deleted, keeps its last live version, and leaves replies alone', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), [message('reply-1')]);
    const live_root = first.root;

    const removed = mark_root_removed(harness.scope, first);

    expect(removed.root.deleted_at).toBe(BACKUP_AT);
    expect(removed.root.kept?.storage_key).toBe(live_root.storage_key);
    expect(removed.replies).toEqual(first.replies);
    expect(removed.deleted_at).toBe(BACKUP_AT);
  });

  it('returns an equal thread when the root is already removed', async () => {
    const harness = make_harness();
    const first = await store(harness, undefined, message('root-1'), []);
    const removed = mark_root_removed(harness.scope, first);

    expect(mark_root_removed(harness.scope, removed)).toEqual(removed);
  });
});
