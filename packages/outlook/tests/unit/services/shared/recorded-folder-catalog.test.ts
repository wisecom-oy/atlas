import { describe, it, expect, vi } from 'vitest';
import {
  MailboxNotLicensedError,
  NotFoundError,
  ThrottledError,
  type MailboxConnector,
  type MailFolder,
  type Manifest,
  type ManifestEntry,
} from '@wisecom/atlas-types';
import {
  list_selectable_folders,
  resolve_folder_paths,
  type SourceFolders,
} from '@/services/shared/recorded-folder-catalog';

function folder(folder_id: string, folder_path: string, well_known_name?: string): MailFolder {
  return {
    folder_id,
    folder_path,
    display_name: folder_path.split('/').at(-1)!,
    total_item_count: 1,
    ...(well_known_name ? { well_known_name } : {}),
  } as MailFolder;
}

function recording(folders: MailFolder[] | undefined): Manifest {
  return { folders } as unknown as Manifest;
}

function entry(folder_id: string | undefined, recoverable_items = false): ManifestEntry {
  return {
    object_id: `m-${folder_id ?? 'none'}`,
    ...(folder_id ? { folder_id } : {}),
    ...(recoverable_items ? { recoverable_items: true } : {}),
  } as ManifestEntry;
}

function source(manifests: Manifest[], live: MailFolder[] | Error = []): SourceFolders {
  const list_mail_folders =
    live instanceof Error ? vi.fn().mockRejectedValue(live) : vi.fn().mockResolvedValue(live);
  return {
    connector: { list_mail_folders } as unknown as MailboxConnector,
    tenant_id: 't',
    owner_id: 'source-owner',
    manifests,
  };
}

const NOT_FOUND = Object.assign(new Error('ErrorItemNotFound'), { statusCode: 404 });

describe('resolve_folder_paths', () => {
  it('names every folder from the manifests without listing the source mailbox (#713)', async () => {
    const src = source(
      [recording([folder('f-in', 'Inbox'), folder('f-sub', 'Inbox/Projects')])],
      NOT_FOUND,
    );

    const map = await resolve_folder_paths(src, [entry('f-in'), entry('f-sub'), entry(undefined)]);

    expect(Object.fromEntries(map)).toEqual({ 'f-in': 'Inbox', 'f-sub': 'Inbox/Projects' });
    expect(src.connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('keeps the first manifest naming a folder, so a moved folder keeps its recorded path', async () => {
    const src = source([
      recording([folder('f-moved', 'Projects/Moved')]),
      recording([folder('f-moved', 'Old Name'), folder('f-gone', 'Gone')]),
    ]);

    const map = await resolve_folder_paths(src, [entry('f-moved'), entry('f-gone')]);

    expect(Object.fromEntries(map)).toEqual({ 'f-moved': 'Projects/Moved', 'f-gone': 'Gone' });
  });

  it('lists the source mailbox for folders a legacy manifest does not record', async () => {
    // Drafts and Outbox must be named, or their mail restores into "Unknown" (issue #142).
    const src = source(
      [recording([folder('f-in', 'Inbox')]), recording(undefined)],
      [folder('f-drafts', 'Drafts'), folder('f-outbox', 'Outbox'), folder('f-in', 'Renamed')],
    );

    const map = await resolve_folder_paths(src, [entry('f-in'), entry('f-drafts')]);

    expect(Object.fromEntries(map)).toEqual({
      'f-in': 'Inbox',
      'f-drafts': 'Drafts',
      'f-outbox': 'Outbox',
    });
  });

  it('widens the fallback listing to Recoverable Items when an entry came from there', async () => {
    const src = source([], [folder('f-purges', 'Recoverable Items/Purges')]);

    await resolve_folder_paths(src, [entry('f-purges', true)]);

    expect(src.connector.list_mail_folders).toHaveBeenCalledWith('t', 'source-owner', {
      include_recoverable_items: true,
    });
  });

  it.each([
    ['a Graph 404', NOT_FOUND],
    ['a translated not-found error', new NotFoundError('gone')],
    ['an unlicensed mailbox', new MailboxNotLicensedError('MailboxNotEnabledForRESTAPI')],
  ])('ends the run with an explanation when the fallback listing meets %s', async (_, error) => {
    const src = source([recording(undefined)], error);

    const run = resolve_folder_paths(src, [entry('f-a'), entry('f-b')]);

    await expect(run).rejects.toBeInstanceOf(NotFoundError);
    await expect(run).rejects.toThrow(/2 folder\(s\) .* not recorded .* source mailbox could not/);
  });

  it('rethrows any other fallback failure as it is', async () => {
    const throttled = new ThrottledError('throttled');
    const src = source([], throttled);

    await expect(resolve_folder_paths(src, [entry('f-a')])).rejects.toBe(throttled);
  });
});

describe('list_selectable_folders', () => {
  it('matches a well-known name against the recorded roles without a live listing', async () => {
    const src = source([recording([folder('f-in', 'Saapuneet', 'inbox')])], NOT_FOUND);

    const folders = await list_selectable_folders(src, [entry('f-in')], 'inbox');

    expect(folders).toEqual([
      { folder_id: 'f-in', folder_path: 'Saapuneet', well_known_name: 'inbox' },
    ]);
    expect(src.connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('takes a role the backup could not tag from the live listing, keeping the recorded path', async () => {
    const src = source(
      [recording([folder('f-in', 'Old Inbox')])],
      [folder('f-in', 'Saapuneet', 'inbox')],
    );

    const folders = await list_selectable_folders(src, [entry('f-in')], 'inbox');

    expect(folders).toEqual([
      { folder_id: 'f-in', folder_path: 'Old Inbox', well_known_name: 'inbox' },
    ]);
  });

  it('returns the recorded folders when an unmatched selector cannot be checked live', async () => {
    const src = source([recording([folder('f-in', 'Inbox')])], NOT_FOUND);

    const folders = await list_selectable_folders(src, [entry('f-in')], 'Typo');

    expect(folders).toEqual([{ folder_id: 'f-in', folder_path: 'Inbox' }]);
  });

  it('fails like a restore when an entry folder is unrecorded and the listing answers 404', async () => {
    const src = source([recording(undefined)], NOT_FOUND);

    await expect(list_selectable_folders(src, [entry('f-a')], 'Inbox')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
