import { describe, expect, it, vi } from 'vitest';
import type { ManifestRepository, ObjectStorage, TenantContextFactory } from '@wisecom/atlas-types';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { DeletionService } from '@/services/deletion/deletion.service';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';

const TENANT_LEASE = '_meta/leases/tenant.json';

function make_storage(listings: string[][]): ObjectStorage {
  const list = vi.fn();
  for (const listing of listings) list.mockResolvedValueOnce(listing);
  list.mockResolvedValue([]);
  return {
    list,
    list_versions: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
  } as unknown as ObjectStorage;
}

function make_factory(storage: ObjectStorage): TenantContextFactory {
  return {
    create_storage_only: vi.fn().mockResolvedValue({ tenant_id: 't', storage }),
  } as unknown as TenantContextFactory;
}

describe('deletion leases', () => {
  it('purges under the tenant lease, sparing that lease until the purge releases it', async () => {
    const storage = make_storage([['data/u/obj', TENANT_LEASE], [], [TENANT_LEASE]]);
    const leases = stub_owner_leases();
    const service = new DeletionService(
      make_factory(storage),
      {} as ManifestRepository,
      leases.leases,
    );

    await service.purge_tenant('t');

    expect(leases.tenant_operations).toEqual(['purge']);
    const deleted = vi.mocked(storage.delete).mock.calls.map(([key]) => key);
    expect(deleted).toEqual(['data/u/obj', TENANT_LEASE]);
  });

  it('deletes an Outlook mailbox under its normalized delete lease', async () => {
    const leases = stub_owner_leases();
    const service = new DeletionService(
      make_factory(make_storage([])),
      {} as ManifestRepository,
      leases.leases,
    );

    await service.delete_mailbox_data('t', 'User@Test.com');

    expect(leases.owner_scopes).toEqual([
      { workload: 'outlook', owner_id: 'user@test.com', operation: 'delete', when_writable: false },
    ]);
  });

  it('deletes OneDrive data and snapshots under the owner delete lease', async () => {
    const leases = stub_owner_leases();
    const service = new OneDriveDeletionService(make_factory(make_storage([])), leases.leases);

    await service.delete_owner_data('t', 'Owner-1');
    await service.delete_snapshot('t', 'Owner-1', 'od-snap-1').catch(() => undefined);

    expect(leases.owner_scopes.map((scope) => scope.owner_id)).toEqual(['owner-1', 'owner-1']);
    expect(new Set(leases.owner_scopes.map((scope) => scope.operation))).toEqual(
      new Set(['delete']),
    );
  });
});
