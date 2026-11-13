/**
 * Issue #740: the OneDrive and SharePoint replication entry points that act on one owner or site
 * take that owner's lease, and the tenant-wide recovery does not. The inner services are stubbed
 * here; their own behaviour is covered elsewhere.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  OwnerLeasePort,
  OwnerLeaseRequest,
  StorageTarget,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { stub_held_owner_lease } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { LeasedOneDriveReplicationService } from '@/services/replication/leased-onedrive-replication.service';
import { LeasedSharePointReplicationService } from '@/services/replication/leased-sharepoint-replication.service';
import type { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import type { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import type { AtlasConfig } from '@/utils/config';

vi.mock('@/services/replication/dek-rehydration-validator', () => ({
  ensure_source_dek_on_primary: vi.fn().mockResolvedValue(undefined),
}));

const SOURCE = {} as StorageTarget;
const TARGETS = [SOURCE];

/** A lease port that records each request, and refuses with `refusal` when one is given. */
function lease_port(refusal?: Error) {
  const acquire = vi.fn(async (_ctx: unknown, _request: OwnerLeaseRequest) => {
    if (refusal) throw refusal;
    return stub_held_owner_lease();
  });
  return { acquire, port: { acquire } as unknown as OwnerLeasePort };
}

function tenant_factory(): TenantContextFactory {
  return {
    create: vi.fn(),
    create_readonly: vi.fn(),
    create_storage_only: vi.fn(async () => ({ storage: {} })),
  } as unknown as TenantContextFactory;
}

const CONFIG = {} as AtlasConfig;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OneDrive owner lease (issue #740)', () => {
  it('takes the owner lease for a replication of one snapshot, normalized, then releases it', async () => {
    const { acquire, port } = lease_port();
    const inner = { replicate_owner: vi.fn(async () => []) };
    const service = new LeasedOneDriveReplicationService(
      inner as unknown as OneDriveReplicationService,
      tenant_factory(),
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.replicate_owner('tenant-1', 'Owner-1', 'od-snap-1', TARGETS);

    expect(acquire.mock.calls[0]?.[1]).toEqual({
      workload: 'onedrive',
      owner_id: 'owner-1',
      operation: 'replicate',
    });
    expect(inner.replicate_owner).toHaveBeenCalledWith('tenant-1', 'owner-1', 'od-snap-1', TARGETS);
  });

  it('takes the owner lease for replicateAll of one owner', async () => {
    const { acquire, port } = lease_port();
    const inner = { replicate_all_owner_snapshots: vi.fn(async () => []) };
    const service = new LeasedOneDriveReplicationService(
      inner as unknown as OneDriveReplicationService,
      tenant_factory(),
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.replicate_all_owner_snapshots('tenant-1', 'owner-2', TARGETS);

    expect(acquire.mock.calls[0]?.[1]).toMatchObject({
      owner_id: 'owner-2',
      operation: 'replicate',
    });
  });

  it('installs the source key before it takes the lease for a rehydration of one owner', async () => {
    const { acquire, port } = lease_port();
    const inner = { rehydrate_owner: vi.fn(async () => ({})) };
    const service = new LeasedOneDriveReplicationService(
      inner as unknown as OneDriveReplicationService,
      tenant_factory(),
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.rehydrate_owner('tenant-1', 'owner-1', SOURCE);

    const key_install = vi.mocked(ensure_source_dek_on_primary).mock.invocationCallOrder[0] ?? 0;
    expect(key_install).toBeLessThan(acquire.mock.invocationCallOrder[0] ?? Infinity);
    expect(acquire.mock.calls[0]?.[1]).toMatchObject({
      owner_id: 'owner-1',
      operation: 'rehydrate',
    });
    expect(inner.rehydrate_owner).toHaveBeenCalledWith('tenant-1', 'owner-1', SOURCE);
  });

  it('refuses a busy owner before the inner service runs', async () => {
    const { port } = lease_port(
      new OwnerBusyError({
        workload: 'onedrive',
        owner_id: 'owner-1',
        held_by_operation: 'backup',
        lease_expires_at: undefined,
      }),
    );
    const inner = { rehydrate_owner_snapshot: vi.fn(async () => ({})) };
    const service = new LeasedOneDriveReplicationService(
      inner as unknown as OneDriveReplicationService,
      tenant_factory(),
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await expect(
      service.rehydrate_owner_snapshot('tenant-1', 'owner-1', 'od-snap-1', SOURCE),
    ).rejects.toBeInstanceOf(OwnerBusyError);
    expect(inner.rehydrate_owner_snapshot).not.toHaveBeenCalled();
  });

  it('releases the lease when the inner replication fails', async () => {
    const lease = stub_held_owner_lease();
    const release = vi.spyOn(lease, 'release');
    const port = { acquire: vi.fn(async () => lease) } as unknown as OwnerLeasePort;
    const inner = {
      replicate_owner: vi.fn(async () => {
        throw new Error('copy failed');
      }),
    };
    const service = new LeasedOneDriveReplicationService(
      inner as unknown as OneDriveReplicationService,
      tenant_factory(),
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await expect(
      service.replicate_owner('tenant-1', 'owner-1', 'od-snap-1', TARGETS),
    ).rejects.toThrow('copy failed');
    expect(release).toHaveBeenCalledOnce();
  });

  it('takes no owner lease for the tenant-wide recovery', async () => {
    const { acquire, port } = lease_port();
    const inner = { rehydrate_all_owners: vi.fn(async () => ({})) };
    const service = new LeasedOneDriveReplicationService(
      inner as unknown as OneDriveReplicationService,
      tenant_factory(),
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.rehydrate_all_owners('tenant-1', SOURCE);

    expect(acquire).not.toHaveBeenCalled();
    expect(inner.rehydrate_all_owners).toHaveBeenCalledWith('tenant-1', SOURCE);
  });
});

describe('SharePoint site lease (issue #740)', () => {
  let factory: TenantContextFactory;

  beforeEach(() => {
    factory = tenant_factory();
  });

  it('takes the site lease for a replication of one site, normalized, then releases it', async () => {
    const { acquire, port } = lease_port();
    const inner = { replicate_site: vi.fn(async () => []) };
    const service = new LeasedSharePointReplicationService(
      inner as unknown as SharePointReplicationService,
      factory,
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.replicate_site('tenant-1', 'Site-ABC', 'sp-snap-1', TARGETS);

    expect(acquire.mock.calls[0]?.[1]).toEqual({
      workload: 'sharepoint',
      owner_id: 'site-abc',
      operation: 'replicate',
    });
    expect(inner.replicate_site).toHaveBeenCalledWith('tenant-1', 'site-abc', 'sp-snap-1', TARGETS);
  });

  it('takes the site lease for a rehydration of one snapshot', async () => {
    const { acquire, port } = lease_port();
    const inner = { rehydrate_site_snapshot: vi.fn(async () => ({})) };
    const service = new LeasedSharePointReplicationService(
      inner as unknown as SharePointReplicationService,
      factory,
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.rehydrate_site_snapshot('tenant-1', 'site-1', 'sp-snap-1', SOURCE);

    expect(acquire.mock.calls[0]?.[1]).toMatchObject({
      workload: 'sharepoint',
      operation: 'rehydrate',
    });
  });

  it('refuses a busy site before the inner service runs', async () => {
    const { port } = lease_port(
      new OwnerBusyError({
        workload: 'sharepoint',
        owner_id: 'site-1',
        held_by_operation: 'delete',
        lease_expires_at: undefined,
      }),
    );
    const inner = { replicate_all_site_snapshots: vi.fn(async () => []) };
    const service = new LeasedSharePointReplicationService(
      inner as unknown as SharePointReplicationService,
      factory,
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await expect(
      service.replicate_all_site_snapshots('tenant-1', 'site-1', TARGETS),
    ).rejects.toThrow(OwnerBusyError);
    expect(inner.replicate_all_site_snapshots).not.toHaveBeenCalled();
  });

  it('takes no site lease for the tenant-wide recovery', async () => {
    const { acquire, port } = lease_port();
    const inner = { rehydrate_all_sites: vi.fn(async () => ({})) };
    const service = new LeasedSharePointReplicationService(
      inner as unknown as SharePointReplicationService,
      factory,
      port,
      vi.fn(() => ({}) as StorageTarget) as never,
      CONFIG,
    );

    await service.rehydrate_all_sites('tenant-1', SOURCE);

    expect(acquire).not.toHaveBeenCalled();
  });
});
