import { beforeEach, describe, expect, it } from 'vitest';
import type { TeamsRootChange, TeamsThreadEntry } from '@wisecom/atlas-types';
import { mark_thread_removed, store_thread } from '@/services/backup/thread-store';
import {
  BACKUP_AT,
  HOSTED_BODY,
  live,
  make_harness,
  root,
  tombstone,
  type ThreadHarness,
} from './thread-store-harness';

describe('store_thread', () => {
  let harness: ThreadHarness;

  beforeEach(() => {
    harness = make_harness();
  });

  it('stores a deleted root as a tombstone without listing replies or hosted contents', async () => {
    const entry = await store_thread(harness.scope, 'channel-1', tombstone(), undefined);

    expect(harness.list_replies).not.toHaveBeenCalled();
    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(entry.deleted_at).toBe(BACKUP_AT);
  });

  it('keeps the last live blob of a thread that was deleted', async () => {
    const previous: TeamsThreadEntry = {
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
      last_modified_at: '',
      reply_count: 0,
      hosted: {},
      backup_at: BACKUP_AT,
    };
    const change: TeamsRootChange = { root: root({ deletedDateTime: 'x' }), deleted: true };

    const entry = await store_thread(harness.scope, 'channel-1', change, previous);

    expect(entry.last_live).toEqual({
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
    });
  });

  it('keeps the previous live blob and hosted images when a live root loses a reply', async () => {
    const previous: TeamsThreadEntry = {
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
      last_modified_at: '',
      reply_count: 1,
      hosted: { h1: { storage_key: 'hosted-key', checksum: 'hosted-checksum', size_bytes: 3 } },
      backup_at: BACKUP_AT,
    };
    const change = live([{ id: 'reply-1', deletedDateTime: 'x' }]);

    const entry = await store_thread(harness.scope, 'channel-1', change, previous);

    expect(entry.last_live).toEqual({
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
    });
    expect(entry.hosted.h1).toEqual(previous.hosted.h1);
  });

  it('keeps the pinned last live blob when the same content is seen again', async () => {
    harness = make_harness(true);
    const pinned = { storage_key: 'pinned-key', checksum: 'pinned-checksum', size_bytes: 7 };
    const previous: TeamsThreadEntry = {
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 42,
      last_modified_at: '',
      reply_count: 1,
      hosted: {},
      backup_at: BACKUP_AT,
      last_live: pinned,
    };
    const change = live([{ id: 'reply-1', deletedDateTime: 'x' }]);

    const first = await store_thread(harness.scope, 'channel-1', change, previous);
    const second = await store_thread(harness.scope, 'channel-1', change, first);

    expect(first.last_live).toEqual(pinned);
    expect(second.last_live).toEqual(pinned);
  });

  it('does not upload a live thread whose content matches the previous entry', async () => {
    harness = make_harness(true);
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    harness.put.mockClear();

    const again = await store_thread(harness.scope, 'channel-1', live(), first);

    expect(harness.put).not.toHaveBeenCalled();
    expect(again.checksum).toBe(first.checksum);
    expect(harness.scope.counters.threads_deduplicated).toBe(1);
  });

  it('uploads a thread again when its reply count changes', async () => {
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    harness.put.mockClear();
    const reply = { id: 'reply-1', body: { content: 'new reply' } };

    const again = await store_thread(harness.scope, 'channel-1', live([reply]), first);

    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(again.reply_count).toBe(1);
  });

  it('revives a deleted thread when Graph reports it live again with the same content', async () => {
    const first = await store_thread(harness.scope, 'channel-1', live(), undefined);
    const deleted = mark_thread_removed(harness.scope, first);

    const revived = await store_thread(harness.scope, 'channel-1', live(), deleted);

    expect(revived.deleted_at).toBeUndefined();
    expect(revived.last_live).toBeUndefined();
  });

  it('fetches replies through the connector when the change does not inline them', async () => {
    await store_thread(harness.scope, 'channel-1', { root: root(), deleted: false }, undefined);

    expect(harness.list_replies).toHaveBeenCalledWith(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
      'root-1',
    );
  });

  it('stores hosted contents referenced by the root and downloads them once', async () => {
    harness.list_hosted_contents.mockResolvedValueOnce([{ id: 'h1', contentType: 'image/png' }]);

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: HOSTED_BODY } })),
      undefined,
    );

    expect(harness.list_hosted_contents).toHaveBeenCalledTimes(1);
    expect(harness.download_hosted_content).toHaveBeenCalledTimes(1);
    expect(Object.keys(entry.hosted)).toEqual(['h1']);
    expect(entry.hosted.h1?.content_type).toBe('image/png');
  });

  it('does not list hosted contents when no message references them', async () => {
    await store_thread(harness.scope, 'channel-1', live(), undefined);

    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
  });

  it('does not reference hosted contents of a reply Graph reports as deleted', async () => {
    const deleted_reply = {
      id: 'reply-1',
      body: { content: HOSTED_BODY },
      deletedDateTime: '2025-01-02T00:00:00Z',
    };

    await store_thread(harness.scope, 'channel-1', live([deleted_reply]), undefined);

    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
  });

  it('skips the upload when the content key already exists in storage', async () => {
    harness = make_harness(true);

    await store_thread(harness.scope, 'channel-1', live(), undefined);

    expect(harness.exists).toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
  });

  it('binds each blob to its storage key as associated data', async () => {
    const entry = await store_thread(harness.scope, 'channel-1', live(), undefined);

    expect(harness.encrypt).toHaveBeenCalledWith(expect.any(Buffer), entry.storage_key);
  });
});

describe('mark_thread_removed', () => {
  it('marks a live thread deleted, keeps its blob as the last live one, and makes no Graph call', () => {
    const harness = make_harness();
    const previous: TeamsThreadEntry = {
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 7,
      last_modified_at: '',
      reply_count: 0,
      hosted: {},
      backup_at: BACKUP_AT,
    };

    const removed = mark_thread_removed(harness.scope, previous);

    expect(removed.deleted_at).toBe(BACKUP_AT);
    expect(removed.last_live).toEqual({
      storage_key: 'live-key',
      checksum: 'live-checksum',
      size_bytes: 7,
    });
    expect(harness.list_replies).not.toHaveBeenCalled();
    expect(harness.put).not.toHaveBeenCalled();
  });

  it('returns an already deleted thread unchanged', () => {
    const harness = make_harness();
    const deleted: TeamsThreadEntry = {
      storage_key: 'tomb',
      checksum: 'tomb',
      size_bytes: 1,
      last_modified_at: '',
      reply_count: 0,
      hosted: {},
      backup_at: BACKUP_AT,
      deleted_at: '2024-12-01T00:00:00.000Z',
    };

    expect(mark_thread_removed(harness.scope, deleted)).toBe(deleted);
  });
});
