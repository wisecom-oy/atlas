/**
 * Issue #623: an Outlook deletion and a backup of the same mailbox must not interleave. Both
 * deletions take the mailbox lease. The lease is not encrypted, so a mailbox erasure still needs no
 * tenant key.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest, ManifestRepository, TenantContextFactory } from '@wisecom/atlas-types';
import { NotFoundError, OwnerBusyError } from '@wisecom/atlas-types';
import {
  stub_owner_leases,
  type StubOwnerLeases,
} from '@wisecom/atlas-types/testing/stub-owner-leases';
import { DeletionService } from '@/services/deletion/deletion.service';

const MAILBOX = 'user@test.com';
const LEASE = { workload: 'outlook', owner_id: MAILBOX, operation: 'delete' } as const;
const SNAPSHOT = {
  owner_id: MAILBOX,
  snapshot_id: 'snap-42',
  created_at: new Date('2026-03-01T10:00:00Z'),
} as Manifest;

function make_storage() {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    delete_version: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
  };
}

describe('Outlook deletion under the mailbox lease (issue #623)', () => {
  let storage: ReturnType<typeof make_storage>;
  let destroy: ReturnType<typeof vi.fn>;
  let factory: TenantContextFactory;
  let manifests: ManifestRepository;
  let leases: StubOwnerLeases;
  let service: DeletionService;

  beforeEach(() => {
    storage = make_storage();
    destroy = vi.fn();
    factory = {
      create: vi.fn(),
      create_readonly: vi.fn().mockResolvedValue({ tenant_id: 't', storage, destroy }),
      create_storage_only: vi.fn().mockResolvedValue({ tenant_id: 't', storage }),
    } as unknown as TenantContextFactory;
    manifests = {
      find_by_snapshot: vi.fn().mockResolvedValue(SNAPSHOT),
      list_by_owner: vi.fn().mockResolvedValue([SNAPSHOT]),
      forget_snapshot_summary: vi.fn(),
    } as unknown as ManifestRepository;
    leases = stub_owner_leases();
    service = new DeletionService(factory, manifests, leases.leases);
  });

  it('erases a mailbox under its lease, checked before the first delete', async () => {
    await service.delete_mailbox_data('t', 'User@Test.com');

    expect(leases.requests).toEqual([LEASE]);
    // Checked before the first delete, and again before the lease object is erased.
    expect(leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('erases the mailbox lease object last, after every other scope', async () => {
    await service.delete_mailbox_data('t', MAILBOX);

    const scopes = storage.list_versions.mock.calls.map(([scope]) => scope as string);
    expect(scopes.at(-1)).toBe(`stub-lease/outlook/${MAILBOX}.json`);
    expect(scopes).toContain(`data/${MAILBOX}/`);
  });

  it('erases a mailbox on raw storage, so a lost or wrong passphrase cannot block it', async () => {
    await service.delete_mailbox_data('t', MAILBOX);

    expect(factory.create_storage_only).toHaveBeenCalledWith('t');
    expect(factory.create_readonly).not.toHaveBeenCalled();
    expect(leases.requests).toEqual([LEASE]);
  });

  it('refuses a mailbox erasure while a backup holds the mailbox, before listing anything', async () => {
    leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(service.delete_mailbox_data('t', MAILBOX)).rejects.toBeInstanceOf(OwnerBusyError);

    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.list_versions).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('takes the lease of the mailbox a snapshot belongs to, and gives it back', async () => {
    await service.delete_snapshot('t', 'snap-42');

    expect(leases.requests).toEqual([LEASE]);
    expect(leases.events).toEqual(['acquire', 'assert', 'release']);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('checks the snapshot order under the lease, so a backup cannot add a newer one in between', async () => {
    vi.mocked(manifests.list_by_owner).mockImplementation(async () => {
      expect(leases.events).toEqual(['acquire']);
      return [SNAPSHOT];
    });

    await service.delete_snapshot('t', 'snap-42');

    expect(manifests.list_by_owner).toHaveBeenCalledTimes(1);
  });

  it('refuses a snapshot delete while a backup holds the mailbox, and deletes nothing', async () => {
    leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(service.delete_snapshot('t', 'snap-42')).rejects.toBeInstanceOf(OwnerBusyError);

    expect(manifests.list_by_owner).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.delete_version).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('takes no lease for a snapshot that does not exist', async () => {
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(undefined);

    await expect(service.delete_snapshot('t', 'missing')).rejects.toBeInstanceOf(NotFoundError);

    expect(leases.requests).toEqual([]);
  });
});
