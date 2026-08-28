import { describe, it, expect, vi } from 'vitest';
import type { MailboxConnector, RestoreConnector } from '@wisecom/atlas-types';
import { build_folder_map, ensure_subfolder } from '@/services/restore/folder-restore-planner';

function make_restore_connector(): RestoreConnector {
  let counter = 0;
  return {
    create_mail_folder: vi.fn(async (_t, _o, display_name: string, parent_folder_id?: string) => ({
      folder_id: `new-${++counter}`,
      display_name,
      folder_path: display_name,
      parent_folder_id,
      total_item_count: 0,
    })),
    create_message: vi.fn(),
    add_attachment: vi.fn(),
    create_upload_session: vi.fn(),
    upload_attachment_chunk: vi.fn(),
    count_folder_messages: vi.fn(),
    list_folder_messages: vi.fn(),
  } as unknown as RestoreConnector;
}

describe('ensure_subfolder', () => {
  it('recreates the source nesting under the restore root', async () => {
    const connector = make_restore_connector();
    const folder_map = new Map([['orig', 'Inbox/Projects/2026']]);

    const target = await ensure_subfolder(
      connector,
      't',
      'user@test.com',
      'root',
      'orig',
      folder_map,
      new Map(),
    );

    const calls = vi.mocked(connector.create_mail_folder).mock.calls;
    expect(calls.map((c) => [c[2], c[3]])).toEqual([
      ['Inbox', 'root'],
      ['Projects', 'new-1'],
      ['2026', 'new-2'],
    ]);
    expect(target).toBe('new-3');
  });

  it('creates a shared parent only once across sibling folders', async () => {
    const connector = make_restore_connector();
    const folder_map = new Map([
      ['a', 'Inbox/Projects/2025'],
      ['b', 'Inbox/Projects/2026'],
    ]);
    const created = new Map<string, string>();

    await ensure_subfolder(connector, 't', 'user@test.com', 'root', 'a', folder_map, created);
    await ensure_subfolder(connector, 't', 'user@test.com', 'root', 'b', folder_map, created);

    const names = vi.mocked(connector.create_mail_folder).mock.calls.map((c) => c[2]);
    expect(names).toEqual(['Inbox', 'Projects', '2025', '2026']);
  });

  it('reuses the cached target for a folder already restored', async () => {
    const connector = make_restore_connector();
    const folder_map = new Map([['orig', 'Inbox']]);
    const created = new Map<string, string>();

    const first = await ensure_subfolder(
      connector,
      't',
      'user@test.com',
      'root',
      'orig',
      folder_map,
      created,
    );
    const second = await ensure_subfolder(
      connector,
      't',
      'user@test.com',
      'root',
      'orig',
      folder_map,
      created,
    );

    expect(second).toBe(first);
    expect(connector.create_mail_folder).toHaveBeenCalledTimes(1);
  });

  it('falls back to a single Unknown folder when the path is missing', async () => {
    const connector = make_restore_connector();

    await ensure_subfolder(connector, 't', 'user@test.com', 'root', 'gone', new Map(), new Map());

    expect(vi.mocked(connector.create_mail_folder).mock.calls.map((c) => c[2])).toEqual([
      'Unknown',
    ]);
  });
});

describe('build_folder_map', () => {
  it('maps Drafts and Outbox, so their messages restore into the restore root', async () => {
    // Restore recreates folders by path, so a folder missing from enumeration
    // lands in "Unknown" instead of its own folder (issue #142).
    const connector = {
      list_mail_folders: vi.fn().mockResolvedValue([
        { folder_id: 'f-inbox', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 1 },
        {
          folder_id: 'f-drafts',
          display_name: 'Drafts',
          folder_path: 'Drafts',
          total_item_count: 1,
        },
        {
          folder_id: 'f-outbox',
          display_name: 'Outbox',
          folder_path: 'Outbox',
          total_item_count: 1,
        },
      ]),
    } as unknown as MailboxConnector;

    const map = await build_folder_map(connector, 't', 'user@test.com');

    expect(map.get('f-drafts')).toBe('Drafts');
    expect(map.get('f-outbox')).toBe('Outbox');
  });

  it('recreates a Drafts folder under the restore root', async () => {
    const connector = make_restore_connector();
    const folder_map = new Map([['f-drafts', 'Drafts']]);

    await ensure_subfolder(
      connector,
      't',
      'user@test.com',
      'root',
      'f-drafts',
      folder_map,
      new Map(),
    );

    expect(vi.mocked(connector.create_mail_folder).mock.calls.map((c) => c[2])).toEqual(['Drafts']);
  });
});
