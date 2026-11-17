import { describe, expect, it, vi } from 'vitest';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import { InMemoryTeamsChannelCheckpointRepository } from '@wisecom/atlas-types/testing/in-memory-teams-channel-checkpoint-repository';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  flush_channel_run,
  open_channel_run,
  type ChannelRun,
  type ChannelRunStart,
} from '@/services/backup/channel-run-state';
import { channel_hosted_journal } from '@/services/backup/hosted-journal';
import { store_thread } from '@/services/backup/thread-store';
import { CHANNEL_ID, hosted_body, make_harness, message } from './thread-store-harness';

const START: ChannelRunStart = {
  baseline_shard_key: undefined,
  stored_link: undefined,
  threads: {},
  failed_roots: {},
  hosted_recheck: {},
};

const ROOT: TeamsGraphResource = message('root-1', {
  body: { contentType: 'html', content: hosted_body('root-1', 'h1') },
});

/** A root whose body references `count` hosted images, h0 to h{count-1}. */
function root_with_images(count: number): TeamsGraphResource {
  const images = Array.from({ length: count }, (_, i) => hosted_body('root-1', `h${i}`));
  return message('root-1', { body: { contentType: 'html', content: images.join('') } });
}

/** The channel read the checkpoint resumes, if any, with its hosted journal on the scope. */
async function journaled(
  scope: BackupRunScope,
): Promise<{ readonly run: ChannelRun; readonly scope: BackupRunScope }> {
  const run = await open_channel_run(scope, CHANNEL_ID, START, 'full', false);
  return { run, scope: { ...scope, hosted_journal: channel_hosted_journal(scope, run) } };
}

function harness_with_checkpoints() {
  const harness = make_harness();
  const checkpoints = new InMemoryTeamsChannelCheckpointRepository();
  // Each image has its own bytes, so each lands under its own content-addressed key.
  harness.download_hosted_content.mockImplementation(async (_tenant, _locator, id: string) => ({
    bytes: Buffer.from(`image-${id}`),
    content_type: 'image/png',
  }));
  return { harness, checkpoints, scope: { ...harness.scope, checkpoints } };
}

describe('hosted journal', () => {
  it('reuses an image stored before a crash instead of downloading it again', async () => {
    const { harness, scope } = harness_with_checkpoints();

    // The run stores the image, then dies before the thread is recorded in any segment.
    await store_thread((await journaled(scope)).scope, CHANNEL_ID, undefined, ROOT, []);
    const resumed = await store_thread(
      (await journaled(scope)).scope,
      CHANNEL_ID,
      undefined,
      ROOT,
      [],
    );

    expect(harness.download_hosted_content).toHaveBeenCalledTimes(1);
    expect(resumed.thread.root.hosted.h1?.storage_key).toBeDefined();
  });

  it('writes one small entry per image and the head only once per flush (#620)', async () => {
    const { checkpoints, scope } = harness_with_checkpoints();
    const save_head = vi.spyOn(checkpoints, 'save_head');
    const save_segment = vi.spyOn(checkpoints, 'save_segment');
    const save_hosted_entry = vi.spyOn(checkpoints, 'save_hosted_entry');
    const read = await journaled(scope);

    const stored = await store_thread(read.scope, CHANNEL_ID, undefined, root_with_images(40), []);
    read.run.state.threads['root-1'] = stored.thread;
    await flush_channel_run(scope, read.run, { threads: ['root-1'], seen: ['root-1'] });

    // One head before the first entry, so the entries resume under it, and one for the page.
    expect(save_head).toHaveBeenCalledTimes(2);
    expect(save_segment).toHaveBeenCalledTimes(1);
    expect(save_hosted_entry).toHaveBeenCalledTimes(40);
    expect(read.run.head?.segments).toHaveLength(1);
  });

  it('downloads none of the images again when a read resumes after storing them', async () => {
    const { harness, scope } = harness_with_checkpoints();
    await store_thread(
      (await journaled(scope)).scope,
      CHANNEL_ID,
      undefined,
      root_with_images(5),
      [],
    );

    const resumed = await journaled(scope);
    await store_thread(resumed.scope, CHANNEL_ID, undefined, root_with_images(5), []);

    expect(resumed.run.resumed).toBe(true);
    expect(harness.download_hosted_content).toHaveBeenCalledTimes(5);
  });

  it('downloads an image again when the crash came before its blob was written', async () => {
    const { harness, scope } = harness_with_checkpoints();
    await store_thread((await journaled(scope)).scope, CHANNEL_ID, undefined, ROOT, []);
    // The entry was journaled, but the blob never reached storage.
    for (const key of Object.keys(harness.objects)) {
      if (key.includes('/hosted/')) delete harness.objects[key];
    }

    await store_thread((await journaled(scope)).scope, CHANNEL_ID, undefined, ROOT, []);

    expect(harness.download_hosted_content).toHaveBeenCalledTimes(2);
  });
});
