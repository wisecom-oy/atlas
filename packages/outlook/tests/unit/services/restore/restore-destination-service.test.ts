import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailFolder } from '@wisecom/atlas-types';
import {
  make_restore_entry as make_entry,
  make_restore_manifest as make_manifest,
  make_restore_harness,
  type RestoreHarness,
} from './restore.service.fixtures';

/** Issue #684 through RestoreService: every restore mode honours `destination`. */

function folder(folder_id: string, display_name: string): MailFolder {
  return { folder_id, display_name, folder_path: display_name, total_item_count: 0 };
}

describe('RestoreService destination', () => {
  let harness: RestoreHarness;

  beforeEach(() => {
    harness = make_restore_harness();
    const manifest = make_manifest([make_entry('msg-1', 'f1'), make_entry('msg-2', 'f2')]);
    vi.mocked(harness.mock_manifests.find_by_snapshot).mockResolvedValue(manifest);
    vi.mocked(harness.mock_manifests.list_by_owner).mockResolvedValue([manifest]);
    vi.mocked(harness.mock_restore.create_mail_folder).mockImplementation(async (_t, _o, name) =>
      folder(`new-${name}`, name),
    );
  });

  it('restores a snapshot under the destination and reports its path', async () => {
    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1', {
      destination: 'Recovered/2026-03',
    });

    expect(result.restore_folder_name).toBe('Recovered/2026-03');
    expect(result.restored_count).toBe(2);
    const created = vi.mocked(harness.mock_restore.create_mail_folder).mock.calls;
    expect(created.map(([, , name, parent]) => [name, parent])).toEqual([
      ['Recovered', undefined],
      ['2026-03', 'new-Recovered'],
      ['Inbox', 'new-2026-03'],
      ['Sent', 'new-2026-03'],
    ]);
  });

  it('restores into existing source folders on a repeat run instead of failing', async () => {
    vi.mocked(harness.mock_restore.find_child_mail_folder).mockImplementation(
      async (_t, _o, name, parent) => {
        if (parent === undefined && name === 'Recovered') return folder('rec', 'Recovered');
        if (parent === 'rec' && name === 'Inbox') return folder('rec-inbox', 'Inbox');
        return undefined;
      },
    );

    const result = await harness.service.restore_mailbox('test-tenant', 'user@test.com', {
      destination: 'Recovered',
    });

    expect(result.errors).toEqual([]);
    expect(result.messages.map((m) => m.target_folder_id).sort()).toEqual([
      'new-Sent',
      'rec-inbox',
    ]);
    const created = vi.mocked(harness.mock_restore.create_mail_folder).mock.calls;
    expect(created.map(([, , name]) => name)).toEqual(['Sent']);
  });

  it('restores a single message under the destination', async () => {
    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1', {
      message_ref: 'msg-1',
      destination: 'Recovered',
    });

    expect(result.restore_folder_name).toBe('Recovered');
    expect(result.messages[0]?.target_folder_id).toBe('new-Inbox');
  });

  it('refuses a destination of / before reading storage or calling Graph', async () => {
    await expect(
      harness.service.restore_snapshot('test-tenant', 'snap-1', { destination: '/' }),
    ).rejects.toThrow('names no folder');
    await expect(
      harness.service.restore_mailbox('test-tenant', 'user@test.com', { destination: '' }),
    ).rejects.toThrow('names no folder');

    expect(harness.mock_manifests.find_by_snapshot).not.toHaveBeenCalled();
    expect(harness.mock_manifests.list_by_owner).not.toHaveBeenCalled();
    expect(harness.mock_connector.mailbox_exists).not.toHaveBeenCalled();
  });

  it('refuses a well-known destination before any message is written', async () => {
    vi.mocked(harness.mock_restore.find_child_mail_folder).mockResolvedValue(
      folder('inbox-id', 'Inbox'),
    );
    vi.mocked(harness.mock_restore.find_well_known_folder_role).mockResolvedValue('inbox');

    await expect(
      harness.service.restore_snapshot('test-tenant', 'snap-1', { destination: 'Inbox' }),
    ).rejects.toThrow('well-known folder');
    expect(harness.mock_restore.create_mail_folder).not.toHaveBeenCalled();
    expect(harness.mock_restore.create_message).not.toHaveBeenCalled();
  });

  it('keeps the generated root and looks nothing up without a destination', async () => {
    const result = await harness.service.restore_snapshot('test-tenant', 'snap-1');

    expect(result.restore_folder_name).toMatch(/^Restore-/);
    expect(harness.mock_restore.find_child_mail_folder).not.toHaveBeenCalled();
    expect(harness.mock_restore.find_well_known_folder_role).not.toHaveBeenCalled();
  });
});
