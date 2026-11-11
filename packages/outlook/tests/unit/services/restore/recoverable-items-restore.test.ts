import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MailFolder, MailFolderListOptions, ManifestEntry } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  make_restore_entry,
  make_restore_manifest,
  make_restore_harness,
  type RestoreHarness,
} from './restore.service.fixtures';

/**
 * Issue #700: the live folder listing reaches Recoverable Items only on request, so a
 * Recoverable Items entry restored without it landed in `Unknown`. Issue #701: the skip count
 * covered every Recoverable Items entry, not the ones the selection named.
 */

const VISIBLE: MailFolder[] = [
  { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 10 },
];
const RECOVERABLE: MailFolder[] = [
  {
    folder_id: 'ri-del',
    display_name: 'Deletions',
    folder_path: 'Recoverable Items/Deletions',
    total_item_count: 1,
    is_recoverable_items: true,
  },
  {
    folder_id: 'ri-pur',
    display_name: 'Purges',
    folder_path: 'Recoverable Items/Purges',
    total_item_count: 1,
    is_recoverable_items: true,
  },
];

function recoverable_entry(id: string, folder_id: string): ManifestEntry {
  return { ...make_restore_entry(id, folder_id), recoverable_items: true };
}

describe('Recoverable Items folder naming on restore (#700)', () => {
  let h: RestoreHarness;

  beforeEach(() => {
    h = make_restore_harness();
    vi.mocked(h.mock_connector.list_mail_folders).mockImplementation(
      async (_t: string, _o: string, options?: MailFolderListOptions) =>
        options?.include_recoverable_items === true ? [...VISIBLE, ...RECOVERABLE] : VISIBLE,
    );
  });

  function created_folder_names(): string[] {
    return vi.mocked(h.mock_restore.create_mail_folder).mock.calls.map((c) => c[2]);
  }

  function use_snapshot(entries: ManifestEntry[]): void {
    vi.mocked(h.mock_manifests.find_by_snapshot).mockResolvedValue(make_restore_manifest(entries));
  }

  it('restores a single Recoverable Items message under Recoverable Items/<folder>', async () => {
    use_snapshot([recoverable_entry('r1', 'ri-del'), make_restore_entry('n1', 'f1')]);

    const result = await h.service.restore_snapshot('test-tenant', 'snap-1', {
      message_ref: '1',
      include_recoverable_items: true,
    });

    expect(result.restored_count).toBe(1);
    expect(created_folder_names().slice(1)).toEqual(['Recoverable Items', 'Deletions']);
    expect(created_folder_names()).not.toContain('Unknown');
  });

  it('keeps each Recoverable Items folder apart in a whole-snapshot restore', async () => {
    use_snapshot([recoverable_entry('r1', 'ri-del'), recoverable_entry('r2', 'ri-pur')]);

    await h.service.restore_snapshot('test-tenant', 'snap-1', { include_recoverable_items: true });

    expect(created_folder_names().slice(1)).toEqual(['Recoverable Items', 'Deletions', 'Purges']);
  });

  it('selects a Recoverable Items folder by path in snapshot mode', async () => {
    use_snapshot([recoverable_entry('r1', 'ri-del'), recoverable_entry('r2', 'ri-pur')]);

    const result = await h.service.restore_snapshot('test-tenant', 'snap-1', {
      folder_name: 'Recoverable Items/Deletions',
      include_recoverable_items: true,
    });

    expect(result.restored_count).toBe(1);
    expect(created_folder_names().slice(1)).toEqual(['Recoverable Items', 'Deletions']);
  });

  it('selects a Recoverable Items folder by path in mailbox mode', async () => {
    const manifest = make_restore_manifest([
      recoverable_entry('r1', 'ri-del'),
      make_restore_entry('n1', 'f1'),
    ]);
    vi.mocked(h.mock_manifests.list_by_owner).mockResolvedValue([manifest]);

    const result = await h.service.restore_mailbox('test-tenant', 'user@test.com', {
      folder_name: 'Recoverable Items/Deletions',
      include_recoverable_items: true,
    });

    expect(result.restored_count).toBe(1);
    expect(created_folder_names().slice(1)).toEqual(['Recoverable Items', 'Deletions']);
  });

  it('lists no Recoverable Items folders when no entry needs them', async () => {
    use_snapshot([make_restore_entry('n1', 'f1')]);

    await h.service.restore_snapshot('test-tenant', 'snap-1', { message_ref: '1' });

    for (const call of vi.mocked(h.mock_connector.list_mail_folders).mock.calls) {
      expect(call).toEqual(['test-tenant', 'user@test.com']);
    }
  });
});

describe('Recoverable Items skip count in mailbox mode (#701)', () => {
  it('counts only the Recoverable Items entries the folder filter selected', async () => {
    const h = make_restore_harness();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.mocked(h.mock_manifests.list_by_owner).mockResolvedValue([
      make_restore_manifest([make_restore_entry('n1', 'f1'), recoverable_entry('r1', 'f2')]),
    ]);

    const result = await h.service.restore_mailbox('test-tenant', 'user@test.com', {
      folder_name: 'Inbox',
    });

    const skips = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('Skipping'));
    info.mockRestore();
    expect(result.restored_count).toBe(1);
    expect(skips).toEqual([]);
  });
});
