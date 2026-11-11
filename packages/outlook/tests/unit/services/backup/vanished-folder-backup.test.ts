import { describe, expect, it, vi } from 'vitest';
import type { DeltaSyncResult, MailFolder, Manifest } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';
import type { MailboxSyncHarness } from './mailbox-sync.fixtures';
import { latest_readable } from '@wisecom/atlas-types/testing/readable-listing';

/**
 * Issue #690. A folder deleted while the backup lists folders is skipped instead of failing the
 * run. The run did not finish that folder, so it records no removals, holds back the links of the
 * folders that reported some, and leaves the vanished folder's own link as it was.
 */
const OLD_LINKS = {
  'folder-1': 'https://delta/inbox-old',
  'folder-gone': 'https://delta/gone-old',
  'folder-3': 'https://delta/sent-old',
};
const INBOX: MailFolder = {
  folder_id: 'folder-1',
  display_name: 'Inbox',
  folder_path: 'Inbox',
  total_item_count: 1,
};
const SENT: MailFolder = {
  ...INBOX,
  folder_id: 'folder-3',
  display_name: 'Sent',
  folder_path: 'Sent',
};

function delta(removed_ids: string[]): DeltaSyncResult {
  return { messages: [], removed_ids, delta_link: 'https://delta/new', delta_reset: false };
}

function harness_resuming_from_old_links(): MailboxSyncHarness {
  const harness = create_mailbox_sync_harness();
  vi.mocked(harness.mock_cursors.load).mockResolvedValue({
    owner_id: 'john.doe@example.com',
    delta_links: OLD_LINKS,
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  vi.mocked(harness.mock_manifests.find_latest_readable).mockResolvedValue(
    latest_readable({
      snapshot_id: 'snap-head',
      total_objects: 3,
      delta_links: OLD_LINKS,
      id_format: 'immutable',
      entries: [],
    } as unknown as Manifest),
  );
  vi.mocked(harness.mock_connector.fetch_delta)
    .mockResolvedValueOnce(delta(['msg-removed-from-inbox']))
    .mockResolvedValueOnce(delta([]));
  return harness;
}

/** The connector's listing when "Example Folder" vanished between its parent and child listing. */
function list_with_vanished_folder(harness: MailboxSyncHarness): void {
  vi.mocked(harness.mock_connector.list_mail_folders).mockImplementation(async (_t, _o, opts) => {
    opts?.on_excluded?.({ folder_path: 'Example Folder', reason: 'deleted-during-listing' });
    return [INBOX, SENT];
  });
}

function saved_links(harness: MailboxSyncHarness): Record<string, string> {
  return vi.mocked(harness.mock_cursors.save).mock.calls.at(-1)![1].delta_links;
}

describe('an outlook backup that meets a folder deleted during its folder listing', () => {
  it('completes, reporting the folder as not captured', async () => {
    const harness = harness_resuming_from_old_links();
    list_with_vanished_folder(harness);

    const result = await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(result.summary.folder_errors).toEqual([]);
    expect(result.summary.excluded_folders).toEqual([
      { folder_path: 'Example Folder', reason: 'deleted-during-listing' },
    ]);
    expect(result.manifest.excluded_folders).toEqual(result.summary.excluded_folders);
  });

  it('records no removals, since it did not finish every folder', async () => {
    const harness = harness_resuming_from_old_links();
    list_with_vanished_folder(harness);

    const result = await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(result.manifest.removed_object_ids).toBeUndefined();
  });

  it('keeps the old links of the vanished folder and of folders that reported removals', async () => {
    const harness = harness_resuming_from_old_links();
    list_with_vanished_folder(harness);

    await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(saved_links(harness)).toEqual({
      'folder-1': 'https://delta/inbox-old',
      'folder-gone': 'https://delta/gone-old',
      'folder-3': 'https://delta/new',
    });
  });

  it('records the removals on the next run, once the folder is simply gone from the listing', async () => {
    const harness = harness_resuming_from_old_links();
    vi.mocked(harness.mock_connector.list_mail_folders).mockResolvedValue([INBOX, SENT]);

    const result = await harness.service.sync_mailbox('t', 'john.doe@example.com');

    expect(result.manifest.removed_object_ids).toEqual(['msg-removed-from-inbox']);
    expect(saved_links(harness)['folder-1']).toBe('https://delta/new');
  });
});
