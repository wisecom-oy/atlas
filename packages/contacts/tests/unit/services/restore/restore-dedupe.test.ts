import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type { ContactManifestEntry, GraphContactPayload } from '@wisecom/atlas-types';
import {
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  CONTACTS_MAILBOX,
  CONTACTS_SNAPSHOT,
  contacts_snapshot,
  contacts_target,
  type ContactsTarget,
  SOURCE_CONTACT_TAG_ID,
  stored_contact,
} from '@wisecom/atlas-types/testing/stub-contacts-snapshots';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsRestoreService } from '@/services/restore/restore.service';

/** Restores the given entries into `target`; call it twice to model a rerun. */
async function restore_into(
  target: ContactsTarget,
  entries: ContactManifestEntry[],
  objects: Record<string, Buffer>,
) {
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, contacts_snapshot(entries));
  const service = new ContactsRestoreService(tenant_factory_for(ctx), target.connector, manifests);
  return service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
    snapshot_id: CONTACTS_SNAPSHOT,
  });
}

/** Two people who share a display name and have no email, phone or company. */
const SAME_NAME = { displayName: 'Example Person' };

function created_ids(target: ContactsTarget): unknown[] {
  return target.created.map((c) => c.payload['singleValueExtendedProperties']);
}

describe('ContactsRestoreService dedupe', () => {
  it('restores a deleted contact whose name matches another contact still in the folder', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', { id: 'c1', ...SAME_NAME }),
      stored_contact(objects, 'c2', 'src-default', { id: 'c2', ...SAME_NAME }),
    ];
    // The source mailbox still holds c1 under the id the backup recorded; c2 was deleted.
    const target = contacts_target([{ id: 'c1', ...SAME_NAME }]);

    const result = await restore_into(target, entries, objects);

    expect(result.contacts_skipped).toBe(1);
    expect(result.contacts_restored).toBe(1);
    expect(created_ids(target)).toEqual([[{ id: SOURCE_CONTACT_TAG_ID, value: 'c2' }]]);
  });

  it('restores both same-name contacts into an empty folder and creates nothing on a rerun', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', { id: 'c1', ...SAME_NAME }),
      stored_contact(objects, 'c2', 'src-default', { id: 'c2', ...SAME_NAME }),
    ];
    const target = contacts_target();

    const first = await restore_into(target, entries, objects);
    const second = await restore_into(target, entries, objects);

    expect(first.contacts_restored).toBe(2);
    expect(second.contacts_restored).toBe(0);
    expect(second.contacts_skipped).toBe(2);
    expect(target.contacts['f-default']).toHaveLength(2);
  });

  it('does not duplicate contacts with no name, email, phone or company on a rerun', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [
      stored_contact(objects, 'c1', 'src-default', { id: 'c1', personalNotes: 'first' }),
      stored_contact(objects, 'c2', 'src-default', { id: 'c2', personalNotes: 'second' }),
      stored_contact(objects, 'c3', 'src-sub', { id: 'c3' }),
    ];
    const target = contacts_target();

    const first = await restore_into(target, entries, objects);
    const second = await restore_into(target, entries, objects);

    expect(first.contacts_restored).toBe(3);
    expect(second.contacts_skipped).toBe(3);
    expect(target.created).toHaveLength(3);
    expect(second.folders_created).toBe(0);
  });

  it('skips an entry whose content matches an untagged contact the snapshot does not hold', async () => {
    const objects: Record<string, Buffer> = {};
    const payload = { displayName: 'Example Person', businessPhones: ['+1 555 0100'] };
    const entries = [stored_contact(objects, 'c1', 'src-default', { id: 'c1', ...payload })];
    // A copy an earlier, untagged restore made: same content, a different id.
    const target = contacts_target([{ id: 'copy-1', ...payload, businessPhones: ['+15550100'] }]);

    const result = await restore_into(target, entries, objects);

    expect(result.contacts_skipped).toBe(1);
    expect(target.created).toEqual([]);
  });

  it('restores an entry when the only same-content contact is tagged with another source id', async () => {
    const objects: Record<string, Buffer> = {};
    const entries = [stored_contact(objects, 'c2', 'src-default', { id: 'c2', ...SAME_NAME })];
    const tagged: GraphContactPayload = {
      id: 'new-9',
      ...SAME_NAME,
      singleValueExtendedProperties: [{ id: SOURCE_CONTACT_TAG_ID, value: 'c1' }],
    };
    const target = contacts_target([tagged]);

    const result = await restore_into(target, entries, objects);

    expect(result.contacts_restored).toBe(1);
  });
});
