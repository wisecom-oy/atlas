import { describe, expect, it, vi } from 'vitest';
import type {
  IdentityRegistry,
  IdentityRegistryRepository,
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { InMemoryIdentityRegistryRepository } from '@wisecom/atlas-types/testing/in-memory-identity-registry';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

// Tenant A is the tenant the Graph credentials belong to; tenant B is read through them.
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const EMAIL = 'shared.user@example.com';

const JOHN: ResolvedUserIdentity = {
  object_id: 'oid-john',
  display_name: 'John Doe',
  email: EMAIL,
};
const JOHN_RECYCLED: ResolvedUserIdentity = {
  object_id: 'oid-john-2',
  display_name: 'John Doe',
  email: EMAIL,
};
const JANE: ResolvedUserIdentity = {
  object_id: 'oid-jane',
  display_name: 'Jane Roe',
  email: EMAIL,
};

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

function registry_of(tenant_id: string, identity: ResolvedUserIdentity): IdentityRegistry {
  return {
    tenant_id,
    entries: [{ ...identity, registered_at: '2024-01-01T00:00:00.000Z', status: 'active' }],
  };
}

function tenant_ctx_factory(): TenantContextFactory {
  const make = async (tenant_id: string) =>
    ({ tenant_id, destroy: vi.fn() }) as unknown as TenantContext;
  return { create: make, create_readonly: make, create_storage_only: make };
}

/** Routes each tenant to its own registry. Tenant B's load waits on `b_load` to model a slow read. */
function two_tenant_repo(b_load: Promise<void>): IdentityRegistryRepository {
  const registries = new Map([
    [TENANT_A, new InMemoryIdentityRegistryRepository(registry_of(TENANT_A, JOHN))],
    [TENANT_B, new InMemoryIdentityRegistryRepository(registry_of(TENANT_B, JANE))],
  ]);
  const repo_for = (tenant_id: string): InMemoryIdentityRegistryRepository => {
    const repo = registries.get(tenant_id);
    if (!repo) throw new Error(`no test registry for ${tenant_id}`);
    return repo;
  };
  return {
    load: async (ctx) => {
      if (ctx.tenant_id === TENANT_B) await b_load;
      return repo_for(ctx.tenant_id).load();
    },
    update: (ctx, mutate) => repo_for(ctx.tenant_id).update(ctx, mutate),
  };
}

/** Graph whose user lookup stays open until `answer` is released, then runs `respond`. */
function held_graph(
  answer: Promise<void>,
  respond: () => ResolvedUserIdentity,
): UserIdentityResolver & { resolve_user: ReturnType<typeof vi.fn> } {
  return {
    resolve_user: vi.fn(async () => {
      await answer;
      return respond();
    }),
    resolve_by_object_id: vi.fn(async () => undefined),
  };
}

function resolver_with(graph: UserIdentityResolver, b_load: Promise<void>) {
  return new CachingIdentityResolver(graph, two_tenant_repo(b_load), tenant_ctx_factory(), {
    tenant_id: TENANT_A,
  });
}

describe("CachingIdentityResolver keeps each tenant's identities apart (issue #621)", () => {
  it('answers a Graph-failure fallback from its own tenant while another tenant loads', async () => {
    const b_load = deferred();
    const a_graph = deferred();
    const graph = held_graph(a_graph.promise, () => {
      throw Object.assign(new Error('Graph unavailable'), { statusCode: 503 });
    });
    const resolver = resolver_with(graph, b_load.promise);

    // A loads its registry, then its Graph call stays open.
    const a = resolver.resolve_user(TENANT_A, EMAIL);
    await vi.waitFor(() => expect(graph.resolve_user).toHaveBeenCalledTimes(1));

    // B's slow registry load completes while A is still waiting on Graph.
    const b = resolver.resolve_user(TENANT_B, EMAIL);
    b_load.release();
    await expect(b).resolves.toEqual(JANE);

    // A's fallback must read A's cached identity, not the registry B just loaded.
    a_graph.release();
    await expect(a).resolves.toEqual(JOHN);
  });

  it("does not serve one tenant's registration to another tenant's later lookups", async () => {
    const b_load = deferred();
    const a_graph = deferred();
    const graph = held_graph(a_graph.promise, () => JOHN_RECYCLED);
    const resolver = resolver_with(graph, b_load.promise);

    const a = resolver.resolve_user(TENANT_A, EMAIL);
    await vi.waitFor(() => expect(graph.resolve_user).toHaveBeenCalledTimes(1));
    const b = resolver.resolve_user(TENANT_B, EMAIL);
    b_load.release();
    await expect(b).resolves.toEqual(JANE);

    // A's Graph answer is a new object id, so A registers it and reindexes after B loaded.
    a_graph.release();
    await expect(a).resolves.toEqual(JOHN_RECYCLED);

    await expect(resolver.resolve_user(TENANT_B, EMAIL)).resolves.toEqual(JANE);
    await expect(resolver.resolve_by_object_id(TENANT_B, JOHN.object_id)).resolves.toBeUndefined();
    await expect(resolver.resolve_by_object_id(TENANT_A, JOHN.object_id)).resolves.toEqual(JOHN);
  });
});
