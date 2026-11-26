/**
 * Issue #974: the single-writer mode keeps the storage lease's rules inside one process. One
 * operation per owner, and the tenant scope excludes every owner of its tenant both ways.
 */
import { describe, expect, it } from 'vitest';
import type { OwnerExclusionGrant, OwnerExclusionRequest } from '@wisecom/atlas-types';
import { InProcessOwnerExclusion } from '@/services/lease/in-process-owner-exclusion';

function owner(owner_id: string, tenant_id = 'tenant-1'): OwnerExclusionRequest {
  return { tenantId: tenant_id, workload: 'outlook', ownerId: owner_id, operation: 'backup' };
}

function tenant(tenant_id = 'tenant-1'): OwnerExclusionRequest {
  return { tenantId: tenant_id, workload: 'tenant', ownerId: tenant_id, operation: 'purge' };
}

async function grant(
  exclusion: InProcessOwnerExclusion,
  request: OwnerExclusionRequest,
): Promise<OwnerExclusionGrant> {
  const result = await exclusion.acquire(request);
  if (!result.acquired) throw new Error('expected a grant');
  return result;
}

describe('InProcessOwnerExclusion (issue #974)', () => {
  it('refuses a second operation on one owner and grants it again after release', async () => {
    const exclusion = new InProcessOwnerExclusion();
    const first = await grant(exclusion, owner('a'));

    await expect(exclusion.acquire(owner('a'))).resolves.toEqual({
      acquired: false,
      heldByOperation: 'backup',
    });
    await first.release();
    await expect(exclusion.acquire(owner('a'))).resolves.toMatchObject({ acquired: true });
  });

  it('lets different owners, workloads and tenants run side by side', async () => {
    const exclusion = new InProcessOwnerExclusion();
    await grant(exclusion, owner('a'));

    await expect(exclusion.acquire(owner('b'))).resolves.toMatchObject({ acquired: true });
    await expect(exclusion.acquire({ ...owner('a'), workload: 'onedrive' })).resolves.toMatchObject(
      { acquired: true },
    );
    await expect(exclusion.acquire(owner('a', 'tenant-2'))).resolves.toMatchObject({
      acquired: true,
    });
  });

  it('refuses the tenant scope while an owner is held, and owners while the tenant is held', async () => {
    const exclusion = new InProcessOwnerExclusion();
    const backup = await grant(exclusion, owner('a'));

    await expect(exclusion.acquire(tenant())).resolves.toMatchObject({ acquired: false });
    await backup.release();
    await grant(exclusion, tenant());
    await expect(exclusion.acquire(owner('b'))).resolves.toEqual({
      acquired: false,
      heldByOperation: 'purge',
    });
    await expect(exclusion.acquire(tenant())).resolves.toMatchObject({ acquired: false });
  });

  it('ignores a second release, so it cannot free a scope another operation took since', async () => {
    const exclusion = new InProcessOwnerExclusion();
    const first = await grant(exclusion, owner('a'));
    await first.release();
    await grant(exclusion, owner('a'));

    await first.release();

    await expect(exclusion.acquire(owner('a'))).resolves.toMatchObject({ acquired: false });
  });
});
