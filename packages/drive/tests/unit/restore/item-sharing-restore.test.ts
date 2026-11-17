import { describe, expect, it, vi } from 'vitest';
import type { DriveSharingConnector } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';
import {
  apply_restored_file_permissions,
  restore_item_metadata_entry,
  type ItemSharingRestoreDeps,
} from '@/restore/item-sharing-restore';
import { SharingRestoreTally } from '@/restore/sharing-restore-tally';

const GRANT = { roles: ['read'], granted_to: { type: 'user' as const, id: 'jane-id' } };

function entry(fields: Partial<DriveManifestEntry>): DriveManifestEntry {
  return {
    file_id: 'id-1',
    drive_id: 'drive-1',
    file_name: 'Team Docs',
    parent_path: '/Shared',
    size_bytes: 0,
    backup_at: '2026-11-01T00:00:00Z',
    change_type: 'created',
    ...fields,
  };
}

function deps(restore_permissions: boolean): ItemSharingRestoreDeps & {
  connector: { [K in keyof DriveSharingConnector]: ReturnType<typeof vi.fn> };
} {
  const connector = {
    fetch_item_permissions: vi.fn(),
    grant_item_access: vi.fn(async () => ({ status: 'applied' as const })),
    create_item_link: vi.fn(async () => ({ status: 'applied' as const })),
  };
  return { connector, restore_permissions, tally: new SharingRestoreTally() };
}

const placement = (ensure_folder = vi.fn(async (path: string) => `id:${path}`)) => ({
  drive_id: 'target-drive',
  restore_root: '/Restore-1',
  ensure_folder,
});

describe('apply_restored_file_permissions (#580)', () => {
  it('sends nothing without the flag and counts what was left out', async () => {
    const sharing = deps(false);

    await apply_restored_file_permissions(
      sharing,
      'drive-1',
      'item-1',
      entry({ permissions: [GRANT] }),
    );

    expect(sharing.connector.grant_item_access).not.toHaveBeenCalled();
    expect(sharing.connector.create_item_link).not.toHaveBeenCalled();
    expect(sharing.tally.summary()).toEqual({ permissions_not_requested: 1 });
  });

  it('grants on the uploaded item when the flag is set', async () => {
    const sharing = deps(true);

    await apply_restored_file_permissions(
      sharing,
      'drive-1',
      'item-1',
      entry({ permissions: [GRANT] }),
    );

    expect(sharing.connector.grant_item_access).toHaveBeenCalledWith('drive-1', 'item-1', {
      recipient: { object_id: 'jane-id' },
      roles: ['read'],
    });
  });

  it('skips with a reason, rather than guessing by path, when Graph returned no item id', async () => {
    const sharing = deps(true);

    await apply_restored_file_permissions(
      sharing,
      'drive-1',
      undefined,
      entry({ permissions: [GRANT] }),
    );

    expect(sharing.connector.grant_item_access).not.toHaveBeenCalled();
    expect(sharing.tally.summary().permissions_skipped).toBe(1);
  });

  it('does nothing for an entry captured before permissions existed', async () => {
    const sharing = deps(true);
    await apply_restored_file_permissions(sharing, 'drive-1', 'item-1', entry({}));
    expect(sharing.tally.summary()).toEqual({});
  });
});

describe('restore_item_metadata_entry for folders (#580)', () => {
  it('reapplies folder permissions on the folder itself when asked', async () => {
    const sharing = deps(true);

    await restore_item_metadata_entry(
      sharing,
      entry({ kind: 'folder', permissions: [GRANT] }),
      placement(),
    );

    expect(sharing.connector.grant_item_access).toHaveBeenCalledWith(
      'target-drive',
      'id:/Restore-1/Shared/Team Docs',
      { recipient: { object_id: 'jane-id' }, roles: ['read'] },
    );
  });

  it('neither creates nor shares a folder when permissions were not asked for', async () => {
    const sharing = deps(false);
    const ensure_folder = vi.fn(async (path: string) => `id:${path}`);

    await restore_item_metadata_entry(
      sharing,
      entry({ kind: 'folder', permissions: [GRANT] }),
      placement(ensure_folder),
    );

    expect(ensure_folder).not.toHaveBeenCalled();
    expect(sharing.tally.summary()).toEqual({ permissions_not_requested: 1 });
  });
});
