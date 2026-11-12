import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3ContactsManifestRepository } from '@/adapters/s3-contacts-manifest-repository.adapter';
import { ContactsQuarantineService } from '@/services/quarantine/quarantine.service';
import { contacts_delta_cursor_key, contacts_manifest_key } from '@/services/shared/storage-keys';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const KEY = contacts_manifest_key(MAILBOX, 'ct-snap-2000-abc');
const CURSOR = contacts_delta_cursor_key(MAILBOX);

function rig() {
  const harness = in_memory_tenant_context();
  harness.set_raw(KEY, Buffer.from('damaged'));
  harness.set_raw(CURSOR, Buffer.from('cursor'));
  const factory = { create: async () => harness.ctx } as unknown as TenantContextFactory;
  const service = new ContactsQuarantineService(
    factory,
    new S3ContactsManifestRepository(),
    stub_owner_leases().leases,
  );
  return { harness, service };
}

describe('ContactsQuarantineService (issue #631)', () => {
  it('moves a damaged manifest and drops the cursor that may describe it', async () => {
    const { harness, service } = rig();

    const result = await service.quarantine_unreadable_object('tenant-1', KEY);

    // Resuming the cursor's links on top of an older manifest would drop every change between
    // the two, so the next backup must read in full.
    expect(result.quarantine_key).toBe(`_quarantine/${KEY}`);
    expect(harness.raw(KEY)).toBeUndefined();
    expect(harness.raw(CURSOR)).toBeUndefined();
  });

  it.each([
    `contacts/manifests/${MAILBOX}/..json`,
    'contacts/manifests/../identity-registry.json',
    'contacts/manifests/./ct-snap-1-abc.json',
    `contacts/manifests/${MAILBOX.toUpperCase()}/ct-snap-2000-abc.json`,
  ])('refuses %s, which Atlas never writes, and leaves the cursor alone', async (key) => {
    const { harness, service } = rig();

    await expect(service.quarantine_unreadable_object('tenant-1', key)).rejects.toThrow(
      /Only Contacts manifests can be quarantined/,
    );
    expect(harness.raw(CURSOR)).toBeDefined();
  });
});
