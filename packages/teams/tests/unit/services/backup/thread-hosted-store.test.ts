import { describe, expect, it } from 'vitest';
import type { TeamsThreadEntry } from '@wisecom/atlas-types';
import { store_thread } from '@/services/backup/thread-store';
import { BACKUP_AT, HOSTED_BODY, live, make_harness, root } from './thread-store-harness';

describe('store_thread hosted contents', () => {
  it('fails the root when a referenced hosted id is not listed by Graph', async () => {
    const harness = make_harness(false);

    await expect(
      store_thread(
        harness.scope,
        'channel-1',
        live([], root({ body: { content: HOSTED_BODY } })),
        undefined,
      ),
    ).rejects.toThrow(/references hosted content not listed by Graph: h1/);
    expect(harness.download_hosted_content).not.toHaveBeenCalled();
  });

  it('fails the root when an unlisted id is referenced through an HTML entity', async () => {
    const harness = make_harness(false);
    const body = '<img src="https://g/hostedContents&#47;h9&#47;$value">';

    await expect(
      store_thread(
        harness.scope,
        'channel-1',
        live([], root({ body: { content: body } })),
        undefined,
      ),
    ).rejects.toThrow(/hosted content not listed by Graph: h9/);
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
