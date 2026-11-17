import { describe, expect, it, vi } from 'vitest';
import type { MailFolder, RestoreConnector } from '@wisecom/atlas-types';
import { FolderReusingRestoreConnector } from '@/services/restore/folder-reusing-restore-connector';
import { ensure_subfolder } from '@/services/restore/folder-restore-planner';

/**
 * Issue #684: a second restore into the same destination meets the source folders the first one
 * created. A plain create is refused by Graph for each of them, which cost every message in those
 * folders (the #360 path), so the restore has to reuse them.
 */

function folder(folder_id: string, display_name: string): MailFolder {
  return { folder_id, display_name, folder_path: display_name, total_item_count: 0 };
}

/** Graph's behaviour: a second folder of the same name under one parent is refused. */
function make_mailbox(existing: Record<string, MailFolder>): RestoreConnector {
  return {
    find_child_mail_folder: vi.fn(async (_t: string, _o: string, name: string, parent?: string) => {
      return existing[`${parent ?? 'root'}/${name.toLowerCase()}`];
    }),
    create_mail_folder: vi.fn(async (_t: string, _o: string, name: string, parent?: string) => {
      if (existing[`${parent ?? 'root'}/${name.toLowerCase()}`]) {
        throw new Error('ErrorFolderExists: A folder with the specified name already exists.');
      }
      return folder(`new-${name}`, name);
    }),
  } as unknown as RestoreConnector;
}

const PREVIOUS_RUN = {
  'dest/inbox': folder('prev-inbox', 'Inbox'),
  'prev-inbox/projects': folder('prev-projects', 'Projects'),
};

const FOLDER_MAP = new Map([
  ['src-projects', 'Inbox/Projects'],
  ['src-2026', 'Inbox/Projects/2026'],
]);

describe('FolderReusingRestoreConnector', () => {
  it('fails on a repeat restore without reuse, which is what this connector fixes', async () => {
    const mailbox = make_mailbox(PREVIOUS_RUN);

    await expect(
      ensure_subfolder(mailbox, 't', 'u', 'dest', 'src-projects', FOLDER_MAP, new Map()),
    ).rejects.toThrow('ErrorFolderExists');
  });

  it('reuses the source subfolders a previous restore left under the destination', async () => {
    const mailbox = make_mailbox(PREVIOUS_RUN);
    const reusing = new FolderReusingRestoreConnector(mailbox);

    const target = await ensure_subfolder(
      reusing,
      't',
      'u',
      'dest',
      'src-projects',
      FOLDER_MAP,
      new Map(),
    );

    expect(target).toBe('prev-projects');
    expect(mailbox.create_mail_folder).not.toHaveBeenCalled();
  });

  it('creates the missing level under a reused one and looks up nothing beneath it', async () => {
    const mailbox = make_mailbox(PREVIOUS_RUN);
    const reusing = new FolderReusingRestoreConnector(mailbox);
    const created = new Map<string, string>();

    await ensure_subfolder(reusing, 't', 'u', 'dest', 'src-2026', FOLDER_MAP, created);
    const deeper = await reusing.create_mail_folder('t', 'u', 'Q1', 'new-2026');

    expect(vi.mocked(mailbox.create_mail_folder).mock.calls).toEqual([
      ['t', 'u', '2026', 'prev-projects'],
      ['t', 'u', 'Q1', 'new-2026'],
    ]);
    // Inbox, Projects and 2026 were looked up; Q1's parent was created in this run, so it was not.
    expect(mailbox.find_child_mail_folder).toHaveBeenCalledTimes(3);
    expect(deeper.folder_id).toBe('new-Q1');
  });

  it('reports whether a folder was found or created', async () => {
    const reusing = new FolderReusingRestoreConnector(make_mailbox(PREVIOUS_RUN));

    await expect(reusing.find_or_create_mail_folder('t', 'u', 'INBOX', 'dest')).resolves.toEqual({
      folder: PREVIOUS_RUN['dest/inbox'],
      created: false,
    });
    await expect(reusing.find_or_create_mail_folder('t', 'u', 'Sent', 'dest')).resolves.toEqual({
      folder: folder('new-Sent', 'Sent'),
      created: true,
    });
  });
});
