import { describe, expect, it } from 'vitest';
import type { ContactFolderRecord } from '@wisecom/atlas-types';
import { folder } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { contacts_target } from '@wisecom/atlas-types/testing/stub-contacts-snapshots';

import { map_source_folders } from '@/services/restore/restore-folder-mapper';

const TARGET = { tenant_id: 'tenant-1', mailbox_id: 'mailbox-1' };

const SOURCE: ContactFolderRecord[] = [
  { folder_id: 'src-default', display_name: 'Contacts', path: [] },
  { folder_id: 'src-team', display_name: 'Team', path: ['Team'] },
  { folder_id: 'src-sub', display_name: 'Sub', path: ['Team', 'Sub'] },
];

describe('map_source_folders', () => {
  it('maps a source folder onto a target folder whose name differs only in case', async () => {
    const target = contacts_target();
    target.connector.list_contact_folders = async () => [
      folder('f-default', 'Contacts'),
      folder('f-team', 'team', ['team']),
      folder('f-sub', 'SUB', ['team', 'SUB']),
    ];

    const mapping = await map_source_folders(target.connector, TARGET, SOURCE);

    expect(target.created_folders).toEqual([]);
    expect(mapping.errors).toEqual([]);
    expect([...mapping.target_by_source]).toEqual([
      ['src-default', 'f-default'],
      ['src-team', 'f-team'],
      ['src-sub', 'f-sub'],
    ]);
  });

  it('creates missing folders parent first and maps each source folder to its own target', async () => {
    const target = contacts_target();

    const mapping = await map_source_folders(target.connector, TARGET, SOURCE);

    expect(target.created_folders).toEqual([
      { parent: 'f-default', name: 'Team' },
      { parent: 'f-new-1', name: 'Sub' },
    ]);
    expect(mapping.folders_created).toBe(2);
    expect(mapping.target_by_source.get('src-sub')).toBe('f-new-2');
  });
});
