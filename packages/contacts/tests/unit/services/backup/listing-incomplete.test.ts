import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import {
  contact,
  fake_connector,
  memory_cursors,
  memory_manifests,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { ContactsBackupService } from '@/services/backup/backup.service';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';

/**
 * Issue #853: a contact folder listing that ended early was taken as the whole mailbox, so the next
 * snapshot dropped the unlisted folders' contacts and the cursor dropped their delta links.
 */
describe('contacts backup with a folder listing that ends early (issue #853)', () => {
  it('fails the run and writes neither snapshot nor cursor, keeping every folder as it was', async () => {
    const { connector, script } = fake_connector();
    const manifests = memory_manifests();
    const cursors = memory_cursors();
    const service = new ContactsBackupService(
      tenant_factory_for(stub_tenant_context().ctx),
      connector,
      manifests,
      cursors,
      stub_owner_leases().leases,
    );
    script.deltas = {
      'f-default': { upserted: [contact('c1')], removed_ids: [], delta_link: 'l-1', reset: false },
      'f-sub': { upserted: [contact('c2')], removed_ids: [], delta_link: 'l-2', reset: false },
    };
    await service.backup_contacts('tenant-1', MAILBOX);
    const [first_snapshot] = manifests.saved;
    const [first_cursor] = cursors.saved;
    connector.list_contact_folders = async () => {
      throw new ListingIncompleteError('contact folders', 0, 1);
    };

    await expect(service.backup_contacts('tenant-1', MAILBOX)).rejects.toBeInstanceOf(
      ListingIncompleteError,
    );

    expect(manifests.saved).toEqual([first_snapshot]);
    expect(cursors.saved).toEqual([first_cursor]);
    expect(first_snapshot?.entries.map((entry) => entry.contact_id).sort()).toEqual(['c1', 'c2']);
  });
});
