import { describe, expect, it, vi } from 'vitest';
import {
  count_created_folders,
  ensure_drive_folder_path,
  type DriveFolderCreator,
} from '@/restore/folder-path';

const TENANT = 'tenant-1';
const OWNER = 'owner-1';

/** Hands out an id per created folder so a caller can tell two folders apart. */
function make_connector(): DriveFolderCreator & { create_folder: ReturnType<typeof vi.fn> } {
  let next = 0;
  return {
    create_folder: vi.fn(
      (_tenant: string, _owner: string, drive_id: string, parent_id: string, name: string) => {
        next++;
        return Promise.resolve(`${drive_id}:${parent_id}:${name}:${next}`);
      },
    ),
  };
}

describe('ensure_drive_folder_path', () => {
  it('creates each missing segment and returns the deepest folder id', async () => {
    const connector = make_connector();
    const memo = new Map<string, string>();

    const id = await ensure_drive_folder_path(
      connector,
      TENANT,
      OWNER,
      'drive-1',
      '/Documents/Reports',
      memo,
    );

    expect(connector.create_folder).toHaveBeenCalledTimes(2);
    expect(id).toBe('drive-1:drive-1:root:Documents:1:Reports:2');
  });

  it('creates a shared parent once across entries', async () => {
    const connector = make_connector();
    const memo = new Map<string, string>();

    await ensure_drive_folder_path(connector, TENANT, OWNER, 'drive-1', '/Restore/a', memo);
    await ensure_drive_folder_path(connector, TENANT, OWNER, 'drive-1', '/Restore/b', memo);

    // `/Restore` once, then one leaf per entry. Re-creating the root per file is what the memo
    // exists to avoid.
    expect(connector.create_folder).toHaveBeenCalledTimes(3);
  });

  it('resolves the same path in two drives to two folders (issue #316)', async () => {
    const connector = make_connector();
    const memo = new Map<string, string>();

    const first = await ensure_drive_folder_path(
      connector,
      TENANT,
      OWNER,
      'drive-1',
      '/Documents/Reports',
      memo,
    );
    const second = await ensure_drive_folder_path(
      connector,
      TENANT,
      OWNER,
      'drive-2',
      '/Documents/Reports',
      memo,
    );

    // Keyed by path alone, the second call answered from the memo and the second drive's files
    // were written into the first drive's folder, with a successful upload against a real id.
    expect(second).not.toBe(first);
    expect(connector.create_folder).toHaveBeenCalledTimes(4);
    const drives_created = connector.create_folder.mock.calls.map((call) => call[2]);
    expect(drives_created).toEqual(['drive-1', 'drive-1', 'drive-2', 'drive-2']);
  });

  it('treats the drive root as root without creating anything', async () => {
    const connector = make_connector();

    for (const path of ['/', '', '.']) {
      expect(
        await ensure_drive_folder_path(
          connector,
          TENANT,
          OWNER,
          'drive-1',
          path,
          new Map<string, string>(),
        ),
      ).toBe('root');
    }
    expect(connector.create_folder).not.toHaveBeenCalled();
  });

  it('returns undefined when a segment cannot be created', async () => {
    const connector = make_connector();
    connector.create_folder.mockRejectedValueOnce(new Error('nameAlreadyExists'));

    const id = await ensure_drive_folder_path(
      connector,
      TENANT,
      OWNER,
      'drive-1',
      '/Documents/Reports',
      new Map<string, string>(),
    );

    // The caller reports that one entry as skipped; one over-long path must not abort the run.
    expect(id).toBeUndefined();
  });

  it('reuses a cached parent from the same drive without recreating it', async () => {
    const connector = make_connector();
    const memo = new Map<string, string>([['drive-1:/Documents', 'cached-id']]);

    const id = await ensure_drive_folder_path(
      connector,
      TENANT,
      OWNER,
      'drive-1',
      '/Documents',
      memo,
    );

    expect(id).toBe('cached-id');
    expect(connector.create_folder).not.toHaveBeenCalled();
  });
});

describe('count_created_folders', () => {
  it('counts the folders created and not the per-drive root markers', async () => {
    const connector = make_connector();
    const memo = new Map<string, string>();

    await ensure_drive_folder_path(connector, TENANT, OWNER, 'drive-1', '/Documents', memo);
    await ensure_drive_folder_path(connector, TENANT, OWNER, 'drive-1', '/', memo);
    await ensure_drive_folder_path(connector, TENANT, OWNER, 'drive-2', '/', memo);

    // Three memo entries, one real folder. Subtracting a constant for "the root" was right for
    // one drive and wrong for every restore that spanned two (issue #316).
    expect(memo.size).toBe(3);
    expect(count_created_folders(memo)).toBe(1);
  });

  it('is zero for a restore that created nothing', () => {
    expect(count_created_folders(new Map())).toBe(0);
  });
});
