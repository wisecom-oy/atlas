import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailedItemLedger, TeamsChannelEntry } from '@wisecom/atlas-types';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { store_thread } from '@/services/backup/thread-store';
import {
  BACKUP_AT,
  CHANNEL,
  CHANNEL_WITH_EMAIL,
  make_connector,
  make_scope,
  previous_channel,
  root_change,
  thread_entry,
} from './channel-backup-processor-harness';

vi.mock('@/services/backup/thread-store', () => ({
  store_thread: vi.fn(),
  mark_thread_removed: vi.fn(),
}));

describe('backup_channel run modes and retries', () => {
  beforeEach(() => {
    vi.mocked(store_thread).mockReset();
    vi.mocked(store_thread).mockImplementation(async (_scope, _channel, root) =>
      thread_entry(root.root.id),
    );
  });

  it('reuses the stored files folder unless the run is a full run', async () => {
    const folder = { id: 'folder-1' } as unknown as TeamsChannelEntry['files_folder'];
    const previous: TeamsChannelEntry = { ...previous_channel({}), files_folder: folder };

    const reused_connector = make_connector();
    const reused = await backup_channel(
      make_scope(reused_connector),
      CHANNEL,
      previous,
      undefined,
      {},
    );
    expect(reused_connector.get_channel_files_folder).not.toHaveBeenCalled();
    expect(reused.entry.files_folder).toBe(folder);

    const full_connector = make_connector();
    await backup_channel(
      make_scope(full_connector, () => false, true),
      CHANNEL,
      previous,
      undefined,
      {},
    );
    expect(full_connector.get_channel_files_folder).toHaveBeenCalledTimes(1);
  });

  it('counts a channel read in full and not one that follows its link', async () => {
    const full = make_scope(make_connector({ list_channel_messages: vi.fn(async () => []) }));
    await backup_channel(full, CHANNEL, undefined, undefined, {});
    expect(full.counters.channels_full_read).toBe(1);

    const delta = make_scope(make_connector());
    await backup_channel(delta, CHANNEL_WITH_EMAIL, previous_channel({}), 'link-old', {});
    expect(delta.counters.channels_full_read).toBe(0);
  });

  it('ignores the stored link on a --full run', async () => {
    const connector = make_connector({ list_channel_messages: vi.fn(async () => []) });

    await backup_channel(
      make_scope(connector, () => false, true),
      CHANNEL_WITH_EMAIL,
      undefined,
      'link-old',
      {},
    );

    expect(connector.fetch_message_delta).toHaveBeenCalledWith(
      'tenant-1',
      '00000000-0000-0000-0000-000000000001',
      'channel-1',
      undefined,
    );
  });

  it('withholds the link of a --full run that leaves a root failed', async () => {
    vi.mocked(store_thread).mockRejectedValueOnce(new Error('boom'));
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('root-1')],
        delta_link: 'link-new',
      })),
    });

    const out = await backup_channel(
      make_scope(connector, () => false, true),
      CHANNEL_WITH_EMAIL,
      undefined,
      'link-old',
      {},
    );

    expect(out.complete).toBe(false);
    expect(out.next_link).toBe('link-old');
  });

  it('stops retrying a root after its fifth failed attempt and lets the link advance', async () => {
    vi.mocked(store_thread).mockRejectedValueOnce(new Error('boom'));
    const connector = make_connector({
      fetch_message_delta: vi.fn(async () => ({
        roots: [root_change('root-1')],
        delta_link: 'link-new',
      })),
    });
    const ledger: FailedItemLedger = {
      'channel-1/root-1': {
        item_id: 'root-1',
        drive_id: 'channel-1',
        name: 'root-1',
        reason: 'boom',
        attempts: 4,
        first_failed_at: BACKUP_AT,
        last_failed_at: BACKUP_AT,
      },
    };

    const out = await backup_channel(
      make_scope(connector),
      CHANNEL_WITH_EMAIL,
      undefined,
      'link-old',
      ledger,
    );

    expect(out.failed_roots['channel-1/root-1']?.attempts).toBe(5);
    expect(out.complete).toBe(true);
    expect(out.next_link).toBe('link-new');
  });

  it('marks a files folder Graph refuses and skips the lookup until a --full run', async () => {
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => 'unavailable' as const),
    });

    const first = await backup_channel(make_scope(connector), CHANNEL, undefined, undefined, {});
    expect(first.entry.files_folder_unavailable).toBe(true);
    expect(first.warnings).toEqual([
      'Channel channel-1: files folder not accessible (403); not retried until a --full run',
    ]);

    await backup_channel(make_scope(connector), CHANNEL, first.entry, undefined, {});
    expect(connector.get_channel_files_folder).toHaveBeenCalledTimes(1);

    await backup_channel(
      make_scope(connector, () => false, true),
      CHANNEL,
      first.entry,
      undefined,
      {},
    );
    expect(connector.get_channel_files_folder).toHaveBeenCalledTimes(2);
  });
});
