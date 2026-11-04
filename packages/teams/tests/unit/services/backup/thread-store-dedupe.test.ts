import { describe, expect, it } from 'vitest';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { store_thread, type ThreadStoreResult } from '@/services/backup/thread-store';
import { CHANNEL_ID, deleted, hosted_body, make_harness, message } from './thread-store-harness';

async function store(
  scope: BackupRunScope,
  previous: ThreadStoreResult | undefined,
  root: TeamsGraphResource = message('root-1'),
): Promise<ThreadStoreResult> {
  return store_thread(scope, CHANNEL_ID, previous?.thread, root, []);
}

describe('store_thread dedupe', () => {
  it('reuses an unchanged live root without writing it again', async () => {
    const harness = make_harness();
    const first = await store(harness.scope, undefined);
    harness.put.mockClear();

    const second = await store(harness.scope, first);

    expect(harness.put).not.toHaveBeenCalled();
    expect(second.deduped).toBe(1);
    expect(second.stored).toBe(0);
    expect(second.thread.root).toEqual(first.thread.root);
  });

  it('rewrites an unchanged live root whose blob is missing', async () => {
    const harness = make_harness();
    const first = await store(harness.scope, undefined);
    delete harness.objects[first.thread.root.storage_key];
    harness.put.mockClear();

    const second = await store(harness.scope, first);

    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(second.deduped).toBe(0);
    expect(second.stored).toBe(1);
  });

  it('does not rewrite an existing blob under --full', async () => {
    const harness = make_harness(true);
    const first = await store(harness.scope, undefined);
    harness.put.mockClear();

    const second = await store(harness.scope, first);

    expect(harness.put).not.toHaveBeenCalled();
    expect(second.stored).toBe(0);
    expect(second.deduped).toBe(0);
  });

  it('stores a changed root under a new key and does not dedupe it', async () => {
    const harness = make_harness();
    const first = await store(harness.scope, undefined);

    const second = await store(
      harness.scope,
      first,
      message('root-1', { body: { contentType: 'html', content: 'edited' } }),
    );

    expect(second.thread.root.storage_key).not.toBe(first.thread.root.storage_key);
    expect(second.stored).toBe(1);
  });

  it('reuses a repeated tombstone whose blob exists', async () => {
    const harness = make_harness();
    const first = await store(harness.scope, undefined, deleted('root-1'));
    harness.put.mockClear();

    const second = await store(harness.scope, first, deleted('root-1'));

    expect(harness.put).not.toHaveBeenCalled();
    expect(second.deduped).toBe(1);
  });

  it('rewrites a repeated tombstone whose blob is missing', async () => {
    const harness = make_harness();
    const first = await store(harness.scope, undefined, deleted('root-1'));
    delete harness.objects[first.thread.root.storage_key];
    harness.put.mockClear();

    const second = await store(harness.scope, first, deleted('root-1'));

    expect(harness.put).toHaveBeenCalledTimes(1);
    expect(second.deduped).toBe(0);
  });

  it('relists hosted content and does not dedupe a message with hosted_missing', async () => {
    const harness = make_harness();
    harness.download_hosted_content.mockRejectedValue(graph_error(404, 'ItemNotFound', 'gone'));
    const root = message('root-1', {
      body: { contentType: 'html', content: hosted_body('root-1', 'h1') },
    });
    const first = await store(harness.scope, undefined, root);
    expect(first.thread.root.hosted_missing).toEqual(['h1']);
    harness.list_hosted_contents.mockClear();

    const second = await store(harness.scope, first, root);

    expect(harness.list_hosted_contents).toHaveBeenCalledTimes(1);
    expect(second.deduped).toBe(0);
  });

  it('does not count a reverted root as stored when its blob already exists', async () => {
    const harness = make_harness();
    const original = await store(harness.scope, undefined);
    const edited = await store(
      harness.scope,
      original,
      message('root-1', { body: { contentType: 'html', content: 'edited' } }),
    );

    const reverted = await store(harness.scope, edited);

    expect(reverted.thread.root.storage_key).toBe(original.thread.root.storage_key);
    expect(reverted.stored).toBe(0);
    expect(reverted.deduped).toBe(0);
  });
});
