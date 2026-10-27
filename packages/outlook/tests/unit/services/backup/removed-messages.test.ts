import { describe, expect, it, vi } from 'vitest';
import type { DeltaSyncResult, Manifest } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness, make_message } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';

/**
 * Issue #512. A delta run's `@removed` ids were dropped, so a snapshot chain brought back mail
 * deleted before the target snapshot. The run now records them, but only when it captured every
 * folder: a message moved into a folder the run never finished, or excluded, would otherwise be
 * hidden.
 */
function delta_with_removals(removed_ids: string[], messages = [] as DeltaSyncResult['messages']) {
  return { messages, removed_ids, delta_link: 'https://delta/new', delta_reset: false };
}

function saved_manifest(harness: MailboxSyncHarness): Manifest {
  return vi.mocked(harness.mock_manifests.save).mock.calls.at(-1)![1];
}

const INBOX = {
  folder_id: 'folder-1',
  display_name: 'Inbox',
  folder_path: 'Inbox',
  total_item_count: 1,
};

describe('an outlook backup whose delta reports removed messages', () => {
  it('writes a manifest recording them even when nothing new was stored', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_manifests.find_latest_by_owner).mockResolvedValue({
      snapshot_id: 'snap-head',
      total_objects: 3,
      delta_links: {},
      id_format: 'immutable',
      entries: [],
    } as unknown as Manifest);
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      delta_with_removals(['msg-deleted']),
    );

    await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(harness.mock_manifests.save).toHaveBeenCalledOnce();
    expect(saved_manifest(harness).removed_object_ids).toEqual(['msg-deleted']);
  });

  it('keeps a message moved in the same run as both an entry and a removal', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      delta_with_removals(['msg-old'], [make_message('msg-moved', 'body')]),
    );

    await harness.service.sync_mailbox('t', 'john.doe@example.com');

    const manifest = saved_manifest(harness);
    expect(manifest.entries.map((e) => e.object_id)).toEqual(['msg-moved']);
    expect(manifest.removed_object_ids).toEqual(['msg-old']);
  });

  it('records none from a folder-filtered run', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      delta_with_removals(['msg-moved-out']),
    );

    await harness.service.sync_mailbox('t', 'john.doe@example.com', { folder_filter: ['Inbox'] });

    expect(saved_manifest(harness).removed_object_ids).toBeUndefined();
  });

  it('records none when another folder failed in the same run', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_connector.list_mail_folders).mockResolvedValue([
      INBOX,
      {
        folder_id: 'folder-2',
        display_name: 'Archive',
        folder_path: 'Archive',
        total_item_count: 1,
      },
    ]);
    vi.mocked(harness.mock_connector.fetch_delta)
      .mockResolvedValueOnce(delta_with_removals(['msg-moved-to-archive']))
      .mockRejectedValueOnce(new Error('Graph 503'));

    await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(saved_manifest(harness).removed_object_ids).toBeUndefined();
  });

  // Issue #534: the move destination was pruned, so the removal must not hide the message.
  it('records none when a folder mail can be moved into was excluded', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_connector.list_mail_folders).mockImplementation(async (_t, _o, opts) => {
      opts?.on_excluded?.({ folder_path: 'Junk Email', reason: 'junk-excluded' });
      return [INBOX];
    });
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      delta_with_removals(['msg-moved-to-junk']),
    );

    await harness.service.sync_mailbox('t', 'john.doe@example.com', { exclude_junk: true });

    expect(saved_manifest(harness).removed_object_ids).toBeUndefined();
  });

  it('still records them when only a hidden system folder was excluded', async () => {
    const harness = create_mailbox_sync_harness();
    vi.mocked(harness.mock_connector.list_mail_folders).mockImplementation(async (_t, _o, opts) => {
      opts?.on_excluded?.({
        folder_path: 'Conversation Action Settings',
        reason: 'hidden-system-folder',
      });
      return [INBOX];
    });
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValue(
      delta_with_removals(['msg-deleted']),
    );

    await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(saved_manifest(harness).removed_object_ids).toEqual(['msg-deleted']);
  });
});
