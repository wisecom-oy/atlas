/**
 * Issue #974: a cross-tenant restore builds its own container. With a host `ownerExclusion` that
 * container must take the source owner through the host's exclusion, not the storage lease.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Container } from 'inversify';
import type { OwnerExclusion } from '@wisecom/atlas-types';
import { create_tenant } from '@/target-tenant';
import { create_outlook_api } from '@/outlook-api.factory';

const create_container_from_config = vi.hoisted(() => vi.fn());
vi.mock('@/container', () => ({ create_container_from_config }));

const SOURCE_CONFIG = {
  tenant_id: 'tenant-source',
  s3_endpoint: 'http://s3.example.com',
  writer_exclusion: 'host_exclusion',
};
const DESTINATION = {
  tenantId: 'contoso.onmicrosoft.com',
  clientId: '00000000-0000-0000-0000-000000000002',
  clientSecret: 'destination-secret-value',
};

function fake_container(services: Record<string, unknown>): Container {
  return {
    get: (token: symbol) => services[token.description!] ?? {},
    isBound: (token: symbol) => token.description! in services,
    unbindAllAsync: async () => undefined,
  } as unknown as Container;
}

function target_container(): Container {
  return fake_container({
    RestoreUseCase: { restore_snapshot: vi.fn().mockResolvedValue({ snapshot_id: 'snap-1' }) },
    GraphIdentityResolver: { resolve_user: vi.fn() },
  });
}

async function restore_across_tenants(source: Container): Promise<void> {
  await create_outlook_api('tenant-source', source).restore('snap-1', {
    targetMailbox: 'oid-destination-john',
    targetTenant: create_tenant(DESTINATION),
  });
}

beforeEach(() => {
  create_container_from_config.mockReset();
  create_container_from_config.mockReturnValue(target_container());
});

describe('cross-tenant restore with a host ownerExclusion (issue #974)', () => {
  it("builds the target container with the instance's ownerExclusion", async () => {
    const exclusion: OwnerExclusion = { acquire: vi.fn() } as unknown as OwnerExclusion;
    const source = fake_container({
      AtlasConfig: SOURCE_CONFIG,
      AtlasSdkOwnerExclusion: exclusion,
    });

    await restore_across_tenants(source);

    expect(create_container_from_config.mock.calls[0]![3]).toBe(exclusion);
  });

  it('passes no exclusion when the instance has none, keeping the storage lease', async () => {
    const source = fake_container({
      AtlasConfig: { ...SOURCE_CONFIG, writer_exclusion: undefined },
    });

    await restore_across_tenants(source);

    expect(create_container_from_config.mock.calls[0]![3]).toBeUndefined();
  });
});
