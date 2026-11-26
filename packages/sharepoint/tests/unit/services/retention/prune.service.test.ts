import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type {
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import {
  readable_indexes,
  readable_summaries,
} from '@wisecom/atlas-types/testing/readable-listing';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { SharePointSnapshotPruneService } from '@/services/retention/prune.service';

const OWNER = 'DDDDDDDD-0000-4000-8000-000000000004';

function rig() {
  const ctx = {
    tenant_id: 't',
    storage: { list: vi.fn(async () => []), list_versions: vi.fn(async () => []) },
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = { create_readonly: vi.fn(async () => ctx) } as unknown as TenantContextFactory;
  const manifests = {
    list_snapshot_summaries: vi.fn(async () => readable_summaries()),
  } as unknown as SharePointManifestRepository;
  const indexes = {
    list_readable_by_site: vi.fn(async () => readable_indexes()),
  } as unknown as SharePointFileVersionIndexRepository;
  const leases = stub_owner_leases();
  const service = new SharePointSnapshotPruneService(factory, manifests, indexes, leases.leases);
  return { service, leases, manifests, ctx };
}

describe('SharePointSnapshotPruneService', () => {
  it('prunes the SharePoint site under its delete lease, by its normalized id, and releases it', async () => {
    const { service, leases, manifests } = rig();

    const result = await service.prune_snapshots('t', OWNER, {
      before: new Date(0),
      dry_run: true,
    });

    expect(result.dry_run).toBe(true);
    expect(leases.requests).toEqual([
      { workload: 'sharepoint', owner_id: OWNER.toLowerCase(), operation: 'delete' },
    ]);
    expect(manifests.list_snapshot_summaries).toHaveBeenCalledWith(
      expect.anything(),
      OWNER.toLowerCase(),
    );
    expect(leases.held()).toBe(0);
  });

  it('is refused with ATLAS_OWNER_BUSY while another operation holds the SharePoint site', async () => {
    const { service, leases, manifests } = rig();
    leases.refuse_with(new OwnerBusyError({ workload: 'sharepoint', owner_id: OWNER }));

    await expect(service.prune_snapshots('t', OWNER, { before: new Date() })).rejects.toMatchObject(
      {
        code: 'ATLAS_OWNER_BUSY',
      },
    );
    expect(manifests.list_snapshot_summaries).not.toHaveBeenCalled();
  });
});
