import { describe, expect, it, vi } from 'vitest';
import type {
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { InMemoryIdentityRegistryRepository } from '@wisecom/atlas-types/testing/in-memory-identity-registry';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

const TENANT = 'tenant-abc';

const JOHN: ResolvedUserIdentity = {
  object_id: 'oid-john',
  display_name: 'John Doe',
  email: 'john.doe@example.com',
};
const JANE: ResolvedUserIdentity = {
  object_id: 'oid-jane',
  display_name: 'Jane Roe',
  email: 'jane.roe@example.com',
};

function graph_for(...identities: ResolvedUserIdentity[]): UserIdentityResolver {
  return {
    resolve_user: vi.fn(async (_tenant: string, email: string) => {
      const hit = identities.find((i) => i.email === email);
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

function resolver_on(repo: InMemoryIdentityRegistryRepository): CachingIdentityResolver {
  return new CachingIdentityResolver(graph_for(JOHN, JANE), repo, ctx_factory());
}

function stored_ids(repo: InMemoryIdentityRegistryRepository): string[] {
  return (repo.stored?.entries ?? []).map((e) => e.object_id).sort();
}

describe('CachingIdentityResolver under concurrent registration (issue #551)', () => {
  it('shares one registry load between concurrent first callers', async () => {
    const repo = new InMemoryIdentityRegistryRepository();
    const load = vi.spyOn(repo, 'load');
    const resolver = resolver_on(repo);

    await Promise.all([
      resolver.resolve_user(TENANT, JOHN.email),
      resolver.resolve_user(TENANT, JANE.email),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(stored_ids(repo)).toEqual(['oid-jane', 'oid-john']);
  });

  it('fails every concurrent first caller when the load fails, then retries on the next call', async () => {
    const repo = new InMemoryIdentityRegistryRepository();
    const load = vi
      .spyOn(repo, 'load')
      .mockRejectedValueOnce(new Error('503 Slow Down'))
      .mockResolvedValueOnce(undefined);
    const resolver = resolver_on(repo);

    const first_round = await Promise.allSettled([
      resolver.resolve_user(TENANT, JOHN.email),
      resolver.resolve_user(TENANT, JANE.email),
    ]);

    expect(first_round.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(repo.writes).toBe(0);
    await expect(resolver.resolve_user(TENANT, JOHN.email)).resolves.toEqual(JOHN);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps both registrations when two instances register different users at once', async () => {
    const repo = new InMemoryIdentityRegistryRepository();
    const first = resolver_on(repo);
    const second = resolver_on(repo);

    await Promise.all([
      first.resolve_user(TENANT, JOHN.email),
      second.resolve_user(TENANT, JANE.email),
    ]);

    // Both read an empty registry, so one of them had to re-apply on top of the other's write.
    expect(repo.conflicts).toBe(1);
    expect(stored_ids(repo)).toEqual(['oid-jane', 'oid-john']);
  });

  it('re-applies a registration when another writer changed the registry mid-write', async () => {
    const repo = new InMemoryIdentityRegistryRepository();
    const resolver = resolver_on(repo);
    await resolver.resolve_by_object_id(TENANT, 'warm-up');
    repo.before_write = () => {
      repo.before_write = undefined;
      repo.replace({
        tenant_id: TENANT,
        entries: [{ ...JANE, registered_at: 'x', status: 'active' }],
      });
    };

    await resolver.resolve_user(TENANT, JOHN.email);

    expect(repo.conflicts).toBe(1);
    expect(stored_ids(repo)).toEqual(['oid-jane', 'oid-john']);
  });

  it('does not duplicate an identity another instance registered after this one loaded', async () => {
    const repo = new InMemoryIdentityRegistryRepository();
    const stale = resolver_on(repo);
    await stale.resolve_by_object_id(TENANT, 'warm-up');
    await resolver_on(repo).resolve_user(TENANT, JOHN.email);
    const writes_before = repo.writes;

    await stale.resolve_user(TENANT, JOHN.email);

    expect(repo.writes).toBe(writes_before);
    expect(stored_ids(repo)).toEqual(['oid-john']);
  });

  it("picks up other writers' entries in its cache after an update", async () => {
    const repo = new InMemoryIdentityRegistryRepository();
    const stale = resolver_on(repo);
    await stale.resolve_by_object_id(TENANT, 'warm-up');
    await resolver_on(repo).resolve_user(TENANT, JANE.email);

    await stale.resolve_user(TENANT, JOHN.email);

    await expect(stale.resolve_by_object_id(TENANT, JANE.object_id)).resolves.toMatchObject({
      email: JANE.email,
    });
  });
});
