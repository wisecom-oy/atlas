import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { InMemoryIdentityRegistryRepository } from '@wisecom/atlas-types/testing/in-memory-identity-registry';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

const TENANT = 'tenant-new';
const JOHN: ResolvedUserIdentity = {
  object_id: 'oid-john',
  display_name: 'John Doe',
  email: 'john.doe@example.com',
};

/** A tenant with no bucket and no data key yet: read-only opens fail, writable opens provision. */
function fresh_tenant_factory(): TenantContextFactory & { create: Mock } {
  const context = { destroy: vi.fn() } as unknown as TenantContext;
  return {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockRejectedValue(new NotFoundError(`No backups for ${TENANT}`)),
    create_storage_only: vi.fn().mockResolvedValue(context),
  };
}

function resolver_with(graph: UserIdentityResolver, factory: TenantContextFactory) {
  return new CachingIdentityResolver(graph, new InMemoryIdentityRegistryRepository(), factory, {
    tenant_id: TENANT,
  });
}

describe('CachingIdentityResolver on a tenant with no storage yet (issue #599)', () => {
  it('provisions nothing when Graph refuses the lookup', async () => {
    const factory = fresh_tenant_factory();
    const graph: UserIdentityResolver = {
      resolve_user: vi.fn().mockRejectedValue(Object.assign(new Error('401'), { statusCode: 401 })),
      resolve_by_object_id: vi.fn(),
    };

    await expect(resolver_with(graph, factory).resolve_user(TENANT, JOHN.email)).rejects.toThrow(
      '401',
    );
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('still provisions the tenant when a resolved user is registered', async () => {
    const factory = fresh_tenant_factory();
    const graph: UserIdentityResolver = {
      resolve_user: vi.fn().mockResolvedValue(JOHN),
      resolve_by_object_id: vi.fn(),
    };

    await expect(resolver_with(graph, factory).resolve_user(TENANT, JOHN.email)).resolves.toEqual(
      JOHN,
    );
    expect(factory.create).toHaveBeenCalledWith(TENANT);
  });
});
