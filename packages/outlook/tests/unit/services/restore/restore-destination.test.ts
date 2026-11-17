import { describe, expect, it, vi } from 'vitest';
import type { MailFolder, RestoreConnector } from '@wisecom/atlas-types';
import {
  open_restore_root,
  parse_restore_destination,
} from '@/services/restore/restore-destination';

/**
 * Issue #684: `--destination` picks the folder an Outlook restore writes under. Each level is
 * reused when it exists, created when it does not, and a well-known folder such as Inbox is
 * refused before anything is created.
 */

function folder(folder_id: string, display_name: string): MailFolder {
  return { folder_id, display_name, folder_path: display_name, total_item_count: 0 };
}

/** A mailbox holding `existing` folders, keyed by `<parent id or root>/<lowercased name>`. */
function make_connector(
  existing: Record<string, MailFolder> = {},
  well_known: Record<string, string> = {},
): RestoreConnector {
  return {
    find_child_mail_folder: vi.fn(async (_t: string, _o: string, name: string, parent?: string) => {
      return existing[`${parent ?? 'root'}/${name.toLowerCase()}`];
    }),
    find_well_known_folder_role: vi.fn(
      async (_t: string, _o: string, id: string) => well_known[id],
    ),
    create_mail_folder: vi.fn(async (_t: string, _o: string, name: string) =>
      folder(`new-${name}`, name),
    ),
  } as unknown as RestoreConnector;
}

describe('parse_restore_destination', () => {
  it('returns undefined when no destination is given', () => {
    expect(parse_restore_destination(undefined)).toBeUndefined();
  });

  it('splits a nested path on / and trims each level', () => {
    expect(parse_restore_destination(' Recovered / 2026-03 incident ')).toEqual([
      'Recovered',
      '2026-03 incident',
    ]);
  });

  it('ignores leading and trailing slashes, as the drive restores do', () => {
    expect(parse_restore_destination('/Recovered/')).toEqual(['Recovered']);
  });

  it.each(['', '   ', '/', '//'])('refuses %j, which names no folder', (destination) => {
    expect(() => parse_restore_destination(destination)).toThrow('names no folder');
  });

  it.each(['Recovered//2026', 'Recovered/ /2026'])('refuses the empty level in %j', (path) => {
    expect(() => parse_restore_destination(path)).toThrow('empty folder name');
  });
});

describe('open_restore_root', () => {
  it('creates the generated Restore-<timestamp> root without a destination, as before', async () => {
    const connector = make_connector();

    const root = await open_restore_root(connector, 't', 'user@example.com', undefined);

    expect(root.connector).toBe(connector);
    expect(root.folder.display_name).toMatch(/^Restore-\d{4}-\d{2}-\d{2}T/);
    expect(connector.create_mail_folder).toHaveBeenCalledTimes(1);
    expect(connector.find_child_mail_folder).not.toHaveBeenCalled();
    expect(connector.find_well_known_folder_role).not.toHaveBeenCalled();
  });

  it('creates every missing level, looking up only the first', async () => {
    const connector = make_connector();

    const root = await open_restore_root(connector, 't', 'u', 'Recovered/2026-03');

    expect(vi.mocked(connector.create_mail_folder).mock.calls).toEqual([
      ['t', 'u', 'Recovered', undefined],
      ['t', 'u', '2026-03', 'new-Recovered'],
    ]);
    // A level created in this run is empty, so nothing beneath it is looked up.
    expect(connector.find_child_mail_folder).toHaveBeenCalledTimes(1);
    expect(connector.find_well_known_folder_role).not.toHaveBeenCalled();
    expect(root.folder).toMatchObject({
      folder_id: 'new-2026-03',
      display_name: 'Recovered/2026-03',
    });
  });

  it('reuses existing levels and creates only the missing ones', async () => {
    const connector = make_connector({ 'root/recovered': folder('rec', 'Recovered') });

    const root = await open_restore_root(connector, 't', 'u', 'recovered/2026-03');

    expect(vi.mocked(connector.create_mail_folder).mock.calls).toEqual([
      ['t', 'u', '2026-03', 'rec'],
    ]);
    expect(root.folder.folder_id).toBe('new-2026-03');
    // Reported as the mailbox spells it, not as typed.
    expect(root.folder.display_name).toBe('Recovered/2026-03');
  });

  it('creates nothing when the whole path already exists', async () => {
    const connector = make_connector({
      'root/recovered': folder('rec', 'Recovered'),
      'rec/2026-03': folder('rec-2026', '2026-03'),
    });

    const root = await open_restore_root(connector, 't', 'u', 'Recovered/2026-03');

    expect(connector.create_mail_folder).not.toHaveBeenCalled();
    expect(root.folder.folder_id).toBe('rec-2026');
  });

  it.each(['Inbox', 'inbox/Recovered'])(
    'refuses %j, inside a well-known folder, before creating anything',
    async (destination) => {
      const connector = make_connector(
        { 'root/inbox': folder('inbox-id', 'Inbox') },
        { 'inbox-id': 'inbox' },
      );

      await expect(open_restore_root(connector, 't', 'u', destination)).rejects.toThrow(
        'well-known folder "Inbox" (inbox)',
      );
      expect(connector.create_mail_folder).not.toHaveBeenCalled();
    },
  );

  it('returns a connector that reuses existing source subfolders on a repeat restore', async () => {
    const connector = make_connector({
      'root/recovered': folder('rec', 'Recovered'),
      'rec/inbox': folder('rec-inbox', 'Inbox'),
    });

    const root = await open_restore_root(connector, 't', 'u', 'Recovered');
    const inbox = await root.connector.create_mail_folder('t', 'u', 'Inbox', root.folder.folder_id);

    expect(inbox.folder_id).toBe('rec-inbox');
    expect(connector.create_mail_folder).not.toHaveBeenCalled();
  });
});
