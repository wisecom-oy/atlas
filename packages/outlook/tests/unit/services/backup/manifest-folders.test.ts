import { describe, expect, it, vi } from 'vitest';
import type { MailFolder } from '@wisecom/atlas-types';
import { create_mailbox_sync_harness } from './mailbox-sync.fixtures';

const INBOX: MailFolder = {
  folder_id: 'f-inbox',
  display_name: 'Saapuneet',
  folder_path: 'Saapuneet',
  total_item_count: 10,
  well_known_name: 'inbox',
};
const PROJECTS: MailFolder = {
  folder_id: 'f-projects',
  display_name: 'Projects',
  folder_path: 'Saapuneet/Projects',
  parent_folder_id: 'f-inbox',
  total_item_count: 2,
};

describe('manifest folder records', () => {
  it('lists the captured folders with their well-known role', async () => {
    const { service, mock_connector, mock_manifests } = create_mailbox_sync_harness();
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([INBOX, PROJECTS]);

    await service.sync_mailbox('t', 'user@test.com');

    const [, manifest] = vi.mocked(mock_manifests.save).mock.calls[0]!;
    expect(manifest.folders).toEqual([INBOX, PROJECTS]);
  });

  it('lists only the folders a folder filter selected', async () => {
    const { service, mock_connector, mock_manifests } = create_mailbox_sync_harness();
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      INBOX,
      { ...PROJECTS, folder_path: 'Projects', parent_folder_id: undefined },
    ]);

    await service.sync_mailbox('t', 'user@test.com', { folder_filter: ['Saapuneet'] });

    const [, manifest] = vi.mocked(mock_manifests.save).mock.calls[0]!;
    expect(manifest.folders?.map((f) => f.folder_id)).toEqual(['f-inbox']);
  });
});
