import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MailFolder, Manifest } from '@wisecom/atlas-types';
import {
  make_restore_entry as make_entry,
  make_restore_manifest as make_manifest,
  make_restore_harness,
  type RestoreHarness,
} from './restore.service.fixtures';

/** The folders the backup recorded; the live listing in the harness no longer has the last two. */
const RECORDED_FOLDERS: MailFolder[] = [
  { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 1 },
  {
    folder_id: 'f-gone',
    display_name: 'Example Folder',
    folder_path: 'Example Folder',
    total_item_count: 1,
  },
  {
    folder_id: 'f-child',
    display_name: 'Child',
    folder_path: 'Example Folder/Child',
    total_item_count: 1,
  },
];

function manifest_with_vanished_folders(): Manifest {
  return {
    ...make_manifest([
      make_entry('msg-1', 'f1'),
      make_entry('msg-2', 'f-gone'),
      make_entry('msg-3', 'f-child'),
    ]),
    folders: RECORDED_FOLDERS,
  };
}

function created_folder_names(harness: RestoreHarness): string[] {
  return vi.mocked(harness.mock_restore.create_mail_folder).mock.calls.map((c) => String(c[2]));
}

describe('RestoreService - folders deleted from the source mailbox (issue #690)', () => {
  let harness: RestoreHarness;

  beforeEach(() => {
    harness = make_restore_harness();
  });

  it('restores every message, naming vanished folders from the manifest', async () => {
    vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(
      manifest_with_vanished_folders(),
    );

    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1');

    expect(result.restored_count).toBe(3);
    expect(created_folder_names(harness)).toEqual(
      expect.arrayContaining(['Inbox', 'Example Folder', 'Child']),
    );
    expect(created_folder_names(harness)).not.toContain('Unknown');
  });

  it('selects a vanished folder by its recorded path in a mailbox restore', async () => {
    vi.mocked(harness.mock_manifests.list_by_owner).mockResolvedValue([
      manifest_with_vanished_folders(),
    ]);

    const result = await harness.service.restore_mailbox('test-tenant', 'user@test.com', {
      folder_name: 'Example Folder',
    });

    expect(result.restored_count).toBe(2);
  });
});
