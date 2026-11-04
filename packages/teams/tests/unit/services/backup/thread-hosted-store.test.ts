import { describe, expect, it } from 'vitest';
import type { TeamsThreadEntry } from '@wisecom/atlas-types';
import { store_thread } from '@/services/backup/thread-store';
import { BACKUP_AT, HOSTED_BODY, live, make_harness, root } from './thread-store-harness';

describe('store_thread hosted contents', () => {
  it('stores the thread and records a referenced hosted id Graph does not list', async () => {
    const harness = make_harness(false);

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: HOSTED_BODY } })),
      undefined,
    );

    expect(entry.hosted_missing).toEqual(['h1']);
    expect(harness.download_hosted_content).not.toHaveBeenCalled();
  });

  it('records an unlisted id referenced through an HTML entity', async () => {
    const harness = make_harness(false);
    const body = '<img src="https://g/hostedContents&#47;h9&#47;$value">';

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: body } })),
      undefined,
    );

    expect(entry.hosted_missing).toEqual(['h9']);
  });

  it('does not treat plain text mentioning a hosted path as a reference', async () => {
    const harness = make_harness(false);
    const body = 'see hostedContents/h1/$value';

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: body } })),
      undefined,
    );

    expect(entry.hosted_missing).toBeUndefined();
    expect(harness.list_hosted_contents).not.toHaveBeenCalled();
  });

  it('reuses a hosted content from the previous entry while its blob exists', async () => {
    const harness = make_harness(true);
    harness.list_hosted_contents.mockResolvedValue([{ id: 'h1' }]);
    const previous_hosted = {
      storage_key: 'hosted-key',
      checksum: 'hosted-checksum',
      size_bytes: 11,
    };
    const previous: TeamsThreadEntry = {
      storage_key: 'old',
      checksum: 'old',
      size_bytes: 1,
      last_modified_at: '',
      reply_count: 0,
      hosted: { h1: previous_hosted },
      backup_at: BACKUP_AT,
    };

    const entry = await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: HOSTED_BODY } })),
      previous,
    );

    expect(harness.download_hosted_content).not.toHaveBeenCalled();
    expect(entry.hosted.h1).toEqual(previous_hosted);
  });

  it('downloads a previously recorded hosted content again when its blob is missing', async () => {
    const harness = make_harness(false);
    harness.list_hosted_contents.mockResolvedValue([{ id: 'h1' }]);
    const previous: TeamsThreadEntry = {
      storage_key: 'old',
      checksum: 'old',
      size_bytes: 1,
      last_modified_at: '',
      reply_count: 0,
      hosted: { h1: { storage_key: 'hosted-key', checksum: 'hosted-checksum', size_bytes: 11 } },
      backup_at: BACKUP_AT,
    };

    await store_thread(
      harness.scope,
      'channel-1',
      live([], root({ body: { content: HOSTED_BODY } })),
      previous,
    );

    expect(harness.download_hosted_content).toHaveBeenCalledTimes(1);
  });
});
