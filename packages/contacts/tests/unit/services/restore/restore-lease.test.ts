/** Issue #623: a contacts restore takes the source mailbox's lease and stops while it is busy. */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { OwnerBusyError } from '@wisecom/atlas-types';
import {
  contact,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  CONTACTS_MAILBOX,
  CONTACTS_SNAPSHOT,
  contacts_snapshot,
  contacts_target,
  stored_contact,
} from '@wisecom/atlas-types/testing/stub-contacts-snapshots';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';
import { ContactsRestoreService } from '@/services/restore/restore.service';

async function service_with(leases: ReturnType<typeof stub_owner_leases>) {
  const objects: Record<string, Buffer> = {};
  const entries = [stored_contact(objects, 'c1', 'src-default', contact('c1'))];
  const { ctx } = stub_tenant_context(objects);
  const manifests = memory_manifests();
  await manifests.save(ctx, contacts_snapshot(entries));
  const target = contacts_target();
  const service = new ContactsRestoreService(
    tenant_factory_for(ctx),
    target.connector,
    manifests,
    leases.leases,
  );
  return { service, target };
}

describe('ContactsRestoreService and the mailbox lease (#623)', () => {
  it('restores under the source mailbox lease and releases it', async () => {
    const leases = stub_owner_leases();
    const { service } = await service_with(leases);

    await service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
      snapshot_id: CONTACTS_SNAPSHOT,
    });

    expect(leases.requests).toEqual([
      { workload: 'contacts', owner_id: CONTACTS_MAILBOX.toLowerCase(), operation: 'restore' },
    ]);
    expect(leases.held()).toBe(0);
  });

  it('restores nothing while another run holds the mailbox', async () => {
    const leases = stub_owner_leases();
    leases.refuse_with(new OwnerBusyError({ workload: 'contacts', owner_id: CONTACTS_MAILBOX }));
    const { service, target } = await service_with(leases);

    const restore = service.restore_contacts('tenant-1', CONTACTS_MAILBOX, {
      snapshot_id: CONTACTS_SNAPSHOT,
    });

    await expect(restore).rejects.toBeInstanceOf(OwnerBusyError);
    expect(target.created).toEqual([]);
  });
});
