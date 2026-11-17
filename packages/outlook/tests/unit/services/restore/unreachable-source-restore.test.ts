import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, type MailFolder, type Manifest } from '@wisecom/atlas-types';
import {
  make_restore_entry as make_entry,
  make_restore_manifest as make_manifest,
  make_restore_harness,
  type RestoreHarness,
} from './restore.service.fixtures';

/**
 * Issue #713: the connector answers 404 for the source owner, as the target tenant's connector
 * does in a cross-tenant restore and as Graph does once the source user has departed. The folders
 * the backup recorded must be enough; the target mailbox is still checked and written live.
 */

const RECORDED_FOLDERS: MailFolder[] = [
  {
    folder_id: 'f1',
    display_name: 'Saapuneet',
    folder_path: 'Saapuneet',
    total_item_count: 1,
    well_known_name: 'inbox',
  },
  {
    folder_id: 'f-child',
    display_name: 'Projects',
    folder_path: 'Saapuneet/Projects',
    total_item_count: 1,
  },
  { folder_id: 'f2', display_name: 'Archive', folder_path: 'Archive', total_item_count: 1 },
];

const TARGET = 'target@other.example';

function recorded_manifest(): Manifest {
  return {
    ...make_manifest([
      make_entry('msg-1', 'f1'),
      make_entry('msg-2', 'f-child'),
      make_entry('msg-3', 'f2'),
    ]),
    folders: RECORDED_FOLDERS,
  };
}

function created_folder_names(harness: RestoreHarness): string[] {
  return vi.mocked(harness.mock_restore.create_mail_folder).mock.calls.map((c) => String(c[2]));
}

describe('RestoreService when Graph does not serve the source mailbox (issue #713)', () => {
  let harness: RestoreHarness;

  beforeEach(() => {
    harness = make_restore_harness();
    vi.mocked(harness.mock_connector.list_mail_folders).mockRejectedValue(
      Object.assign(new Error('ErrorInvalidUser'), { statusCode: 404 }),
    );
    vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(recorded_manifest());
    vi.mocked(harness.mock_manifests.list_by_owner).mockResolvedValue([recorded_manifest()]);
  });

  it('restores a snapshot into another mailbox from the recorded folders', async () => {
    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: TARGET,
    });

    expect(result.restored_count).toBe(3);
    expect(created_folder_names(harness)).toEqual(
      expect.arrayContaining(['Saapuneet', 'Projects', 'Archive']),
    );
    expect(created_folder_names(harness)).not.toContain('Unknown');
    expect(harness.mock_connector.list_mail_folders).not.toHaveBeenCalled();
    expect(harness.mock_connector.mailbox_exists).toHaveBeenCalledWith('test-tenant', TARGET);
  });

  it('restores a mailbox by owner from the recorded folders', async () => {
    const result = await harness.service.restore_mailbox('test-tenant', 'user@test.com', {
      target_mailbox: TARGET,
    });

    expect(result.restored_count).toBe(3);
    expect(harness.mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('restores a single message into its recorded folder', async () => {
    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: TARGET,
      message_ref: 'msg-2',
    });

    expect(result.restored_count).toBe(1);
    expect(created_folder_names(harness)).toEqual(
      expect.arrayContaining(['Saapuneet', 'Projects']),
    );
    expect(harness.mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it.each([
    ['a well-known name', 'inbox'],
    ['a recorded path', 'Saapuneet/Projects'],
  ])('selects a folder by %s with -f', async (_, folder_name) => {
    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: TARGET,
      folder_name,
    });

    expect(result.restored_count).toBe(folder_name === 'inbox' ? 2 : 1);
    expect(harness.mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('names the recorded folders when -f matches none of them', async () => {
    const run = harness.service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: TARGET,
      folder_name: 'Typo',
    });

    await expect(run).rejects.toBeInstanceOf(NotFoundError);
    await expect(run).rejects.toThrow(/Available: Saapuneet, Saapuneet\/Projects, Archive/);
    expect(harness.mock_restore.create_mail_folder).not.toHaveBeenCalled();
  });

  it('fails before writing when a manifest records no folders and the listing answers 404', async () => {
    vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(
      make_manifest([make_entry('msg-1', 'f1')]),
    );

    const run = harness.service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: TARGET,
    });

    await expect(run).rejects.toBeInstanceOf(NotFoundError);
    await expect(run).rejects.toThrow(/not recorded in the backup's manifests/);
    expect(harness.mock_restore.create_mail_folder).not.toHaveBeenCalled();
    expect(harness.mock_restore.create_message).not.toHaveBeenCalled();
  });
});
