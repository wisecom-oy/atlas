import { describe, expect, it } from 'vitest';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { store_thread, type ThreadStoreResult } from '@/services/backup/thread-store';
import {
  CHANNEL_ID,
  hosted_body,
  make_harness,
  message,
  TEAM_ID,
  type ThreadHarness,
} from './thread-store-harness';

const ROOT_LOCATOR = { team_id: TEAM_ID, channel_id: CHANNEL_ID, root_id: 'root-1' };

function root_with_image(hosted_id = 'h1'): TeamsGraphResource {
  return message('root-1', {
    body: { contentType: 'html', content: hosted_body('root-1', hosted_id) },
  });
}

async function store_root(
  harness: ThreadHarness,
  previous: ThreadStoreResult | undefined,
  root: TeamsGraphResource,
): Promise<ThreadStoreResult> {
  return store_thread(harness.scope, CHANNEL_ID, previous?.thread, root, []);
}

describe('store_thread hosted contents', () => {
  it('downloads a referenced item directly by id, without listing the message', async () => {
    const harness = make_harness();

    const result = await store_root(harness, undefined, root_with_image());

    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
    expect(harness.download_hosted_content).toHaveBeenCalledWith('tenant-1', ROOT_LOCATOR, 'h1');
    const hosted = result.thread.root.hosted.h1;
    expect(hosted).toBeDefined();
    expect(harness.objects[hosted?.storage_key ?? '']?.toString()).toBe('image-bytes');
    expect(harness.scope.counters.hosted_content_stored).toBe(1);
  });

  it('passes the reply id when the reference belongs to a reply', async () => {
    const harness = make_harness();
    const reply = message('reply-1', {
      body: { contentType: 'html', content: hosted_body('root-1', 'h2', 'reply-1') },
    });

    await store_thread(harness.scope, CHANNEL_ID, undefined, message('root-1'), [reply]);

    expect(harness.download_hosted_content).toHaveBeenCalledWith(
      'tenant-1',
      { ...ROOT_LOCATOR, reply_id: 'reply-1' },
      'h2',
    );
  });

  it('makes no hosted calls for a message that references none', async () => {
    const harness = make_harness();

    await store_root(harness, undefined, message('root-1'));

    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
    expect(harness.download_hosted_content).not.toHaveBeenCalled();
  });

  it('reuses a previously stored item while its blob exists', async () => {
    const harness = make_harness();
    const first = await store_root(harness, undefined, root_with_image());
    harness.download_hosted_content.mockClear();

    const second = await store_root(harness, first, root_with_image());

    expect(harness.download_hosted_content).not.toHaveBeenCalled();
    expect(second.thread.root.hosted.h1).toEqual(first.thread.root.hosted.h1);
  });

  it('downloads again when a previously stored item’s blob is missing', async () => {
    const harness = make_harness();
    const first = await store_root(harness, undefined, root_with_image());
    delete harness.objects[first.thread.root.hosted.h1?.storage_key ?? ''];
    harness.download_hosted_content.mockClear();

    await store_root(harness, first, root_with_image());

    expect(harness.download_hosted_content).toHaveBeenCalledTimes(1);
  });

  it('marks an item missing on a 404 and still stores the thread with a warning', async () => {
    const harness = make_harness();
    harness.download_hosted_content.mockRejectedValue(graph_error(404, 'ItemNotFound', 'gone'));

    const result = await store_root(harness, undefined, root_with_image());

    expect(result.thread.root.hosted).toEqual({});
    expect(result.thread.root.hosted_missing).toEqual(['h1']);
    expect(result.warnings).toEqual(['hosted content missing on message root-1: 1 item(s)']);
  });

  it('propagates a non-404 download failure', async () => {
    const harness = make_harness();
    harness.download_hosted_content.mockRejectedValue(
      graph_error(500, 'InternalServerError', 'boom'),
    );

    await expect(store_root(harness, undefined, root_with_image())).rejects.toThrow('boom');
  });

  it('relists after a missing item and stores it with the listed content type', async () => {
    const harness = make_harness();
    harness.download_hosted_content.mockRejectedValueOnce(graph_error(404, 'ItemNotFound', 'gone'));
    const first = await store_root(harness, undefined, root_with_image());
    expect(first.thread.root.hosted_missing).toEqual(['h1']);
    harness.list_hosted_contents.mockResolvedValue([{ id: 'h1', contentType: 'image/png' }]);

    const second = await store_root(harness, first, root_with_image());

    expect(harness.list_hosted_contents).toHaveBeenCalledWith('tenant-1', ROOT_LOCATOR);
    expect(second.thread.root.hosted.h1?.content_type).toBe('image/png');
    expect(second.thread.root.hosted_missing).toBeUndefined();
    expect(second.warnings).toEqual([]);
  });

  it('reports an item missing without a download when the relist omits it', async () => {
    const harness = make_harness();
    harness.download_hosted_content.mockRejectedValueOnce(graph_error(404, 'ItemNotFound', 'gone'));
    const first = await store_root(harness, undefined, root_with_image());
    harness.download_hosted_content.mockClear();

    const second = await store_root(harness, first, root_with_image());

    expect(harness.download_hosted_content).not.toHaveBeenCalled();
    expect(second.thread.root.hosted_missing).toEqual(['h1']);
  });
});
