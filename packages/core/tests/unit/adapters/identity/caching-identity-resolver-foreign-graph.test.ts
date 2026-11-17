import { describe, expect, it, vi } from 'vitest';
import type {
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { InMemoryIdentityRegistryRepository } from '@wisecom/atlas-types/testing/in-memory-identity-registry';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

const SOURCE_TENANT = 'tenant-source';
const DESTINATION_TENANT = 'tenant-destination';

/** John as backed up in the source tenant. */
const SOURCE_JOHN: ResolvedUserIdentity = {
  object_id: 'oid-source-john',
  display_name: 'John Doe',
  email: 'john.doe@example.com',
};
/** The same address in the destination tenant, as after a tenant-to-tenant migration. */
const DESTINATION_JOHN: ResolvedUserIdentity = { ...SOURCE_JOHN, object_id: 'oid-dest-john' };
const DESTINATION_JANE: ResolvedUserIdentity = {
  object_id: 'oid-dest-jane',
  display_name: 'Jane Roe',
  email: 'jane.roe@example.com',
};

function destination_graph(): UserIdentityResolver {
  const users = [DESTINATION_JOHN, DESTINATION_JANE];
  return {
    resolve_user: vi.fn(async (_tenant: string, email: string) => {
      const hit = users.find((u) => u.email === email);
      if (!hit) throw Object.assign(new Error('Graph 404'), { statusCode: 404 });
      return hit;
    }),
    resolve_by_object_id: vi.fn().mockResolvedValue(undefined),
  };
}

function ctx_factory(): TenantContextFactory {
  const create = vi.fn(async () => ({ destroy: vi.fn() }) as unknown as TenantContext);
  return { create, create_readonly: create, create_storage_only: create };
}

function source_registry(): InMemoryIdentityRegistryRepository {
  return new InMemoryIdentityRegistryRepository({
    tenant_id: SOURCE_TENANT,
    entries: [{ ...SOURCE_JOHN, registered_at: '2026-01-01T00:00:00.000Z', status: 'active' }],
  });
}

/** A resolver reading the source tenant's storage while Graph signs in to `graph_tenant`. */
function resolver_with_graph_of(
  graph_tenant: string,
  repo: InMemoryIdentityRegistryRepository,
): CachingIdentityResolver {
  return new CachingIdentityResolver(destination_graph(), repo, ctx_factory(), {
    tenant_id: graph_tenant,
  });
}

describe('CachingIdentityResolver when Graph belongs to another tenant (issue #591)', () => {
  it('keeps the backed-up user and never marks it recycled when the same email exists there', async () => {
    const repo = source_registry();
    const before = structuredClone(repo.stored);

    const resolved = await resolver_with_graph_of(DESTINATION_TENANT, repo).resolve_user(
      SOURCE_TENANT,
      SOURCE_JOHN.email,
    );

    expect(resolved.object_id).toBe(SOURCE_JOHN.object_id);
    expect(repo.writes).toBe(0);
    expect(repo.stored).toEqual(before);
  });

  it("returns the other tenant's answer for an unknown email without recording it", async () => {
    const repo = source_registry();

    const resolved = await resolver_with_graph_of(DESTINATION_TENANT, repo).resolve_user(
      SOURCE_TENANT,
      DESTINATION_JANE.email,
    );

    expect(resolved.object_id).toBe(DESTINATION_JANE.object_id);
    expect(repo.writes).toBe(0);
  });

  it('still registers when the storage tenant differs from the Graph tenant only in case', async () => {
    const repo = source_registry();

    await resolver_with_graph_of(SOURCE_TENANT.toUpperCase(), repo).resolve_user(
      SOURCE_TENANT,
      DESTINATION_JOHN.email,
    );

    expect(repo.stored?.entries.map((e) => [e.object_id, e.status])).toEqual(
      expect.arrayContaining([
        [SOURCE_JOHN.object_id, 'recycled'],
        [DESTINATION_JOHN.object_id, 'active'],
      ]),
    );
  });
});
