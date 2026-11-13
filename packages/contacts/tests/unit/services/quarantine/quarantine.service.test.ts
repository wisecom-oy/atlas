import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ContactsSnapshotManifest, TenantContextFactory } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3ContactsManifestRepository } from '@/adapters/s3-contacts-manifest-repository.adapter';
import { ContactsQuarantineService } from '@/services/quarantine/quarantine.service';
import {
  contacts_delta_cursor_key,
  contacts_manifest_key,
  contacts_summary_key,
} from '@/services/shared/storage-keys';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const KEY = contacts_manifest_key(MAILBOX, 'ct-snap-2000-abc');
const CURSOR = contacts_delta_cursor_key(MAILBOX);

/** A readable contacts manifest created at `epoch` milliseconds. */
function snapshot_at(epoch: number): ContactsSnapshotManifest {
  return {
    id: `id-${epoch}`,
    tenant_id: 'tenant-1',
    mailbox_id: MAILBOX,
    snapshot_id: `ct-snap-${epoch}-abc`,
    created_at: new Date(epoch).toISOString(),
    total_contacts: 1,
    total_size_bytes: 10,
    folders: [{ folder_id: 'f1', display_name: 'Contacts', path: [] }],
    entries: [
      { contact_id: 'c1', folder_id: 'f1', storage_key: 'k', checksum: 'x', size_bytes: 10 },
    ],
  };
}

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

  it('drops the moved manifest row from the summary index and keeps the others (#727)', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3ContactsManifestRepository();
    await repo.save(harness.ctx, snapshot_at(1000));
    await repo.save(harness.ctx, snapshot_at(2000));
    harness.set_raw(KEY, Buffer.from('damaged'));
    const factory = { create: async () => harness.ctx } as unknown as TenantContextFactory;
    const service = new ContactsQuarantineService(factory, repo, stub_owner_leases().leases);

    await service.quarantine_unreadable_object('tenant-1', KEY);

    const summary_key = contacts_summary_key(MAILBOX);
    const stored = JSON.parse(
      harness.ctx.decrypt(harness.raw(summary_key)!, summary_key).toString('utf-8'),
    );
    expect(stored.snapshots.map((s: { snapshot_id: string }) => s.snapshot_id)).toEqual([
      'ct-snap-1000-abc',
    ]);
    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);
    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['ct-snap-1000-abc']);
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
