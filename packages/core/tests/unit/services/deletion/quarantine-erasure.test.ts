import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ManifestRepository, TenantContextFactory } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { DeletionService } from '@/services/deletion/deletion.service';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';

const OWNER = '00000000-0000-0000-0000-00000000abcd';

/**
 * Issue #631: a quarantined manifest still lists the owner's messages or files, so erasing the
 * owner's data must remove the quarantined copy too, and leave every other owner's alone.
 */
describe('owner erasure covers quarantined copies', () => {
  function bucket(keys: string[]) {
    const harness = in_memory_tenant_context();
    for (const key of keys) harness.set_raw(key, Buffer.from('x'));
    // An unversioned bucket: no object versions, so every key is removed by a plain delete.
    harness.ctx.storage.list_versions = async () => [];
    const factory = {
      create_storage_only: async () => harness.ctx,
    } as unknown as TenantContextFactory;
    return { harness, factory };
  }

  it('removes an Outlook mailbox quarantined manifest', async () => {
    const other = '_quarantine/manifests/someone-else/snap-2.json';
    const { harness, factory } = bucket([`_quarantine/manifests/${OWNER}/snap-1.json`, other]);

    await new DeletionService(
      factory,
      {} as ManifestRepository,
      stub_owner_leases().leases,
    ).delete_mailbox_data('t', OWNER);

    expect(harness.keys()).toEqual([other]);
  });

  it('removes a OneDrive owner quarantined manifest and version index', async () => {
    const { harness, factory } = bucket([
      `_quarantine/onedrive/manifests/${OWNER}/od-snap-1-abc.json`,
      `_quarantine/onedrive/index/${OWNER}/runs/od-snap-1-abc.json`,
    ]);

    await new OneDriveDeletionService(factory, stub_owner_leases().leases).delete_owner_data(
      't',
      OWNER,
    );

    expect(harness.keys()).toEqual([]);
  });
});
