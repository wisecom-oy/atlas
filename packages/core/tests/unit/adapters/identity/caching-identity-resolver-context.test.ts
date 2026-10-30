import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
  IdentityRegistryRepository,
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

const TENANT = 'tenant-abc';

const IDENTITY: ResolvedUserIdentity = {
  object_id: 'oid-1',
  display_name: 'John Doe',
  email: 'john.doe@example.com',
};

/** A factory whose every created context records its own `destroy` spy (issue #436). */
function make_counting_ctx_factory(): { factory: TenantContextFactory; destroys: Mock[] } {
  const destroys: Mock[] = [];
  const create = vi.fn(async (): Promise<TenantContext> => {
    const destroy = vi.fn();
    destroys.push(destroy);
    return { destroy } as unknown as TenantContext;
  });
  return { factory: { create, create_readonly: create, create_storage_only: create }, destroys };
}

function build_resolver(overrides: { registry_repo?: Partial<IdentityRegistryRepository> }): {
  resolver: CachingIdentityResolver;
  destroys: Mock[];
} {
  const graph: UserIdentityResolver = {
    resolve_user: vi.fn().mockResolvedValue(IDENTITY),
    resolve_by_object_id: vi.fn().mockResolvedValue(undefined),
  };
  const registry_repo: IdentityRegistryRepository = {
    load: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(async (_ctx, mutate) => mutate(undefined)),
    ...overrides.registry_repo,
  };
  const { factory, destroys } = make_counting_ctx_factory();
  return { resolver: new CachingIdentityResolver(graph, registry_repo, factory), destroys };
}

describe('CachingIdentityResolver context lifecycle (issue #436)', () => {
  it('destroys the load and update contexts when resolve_user registers a new identity', async () => {
    const { resolver, destroys } = build_resolver({});

    await expect(resolver.resolve_user(TENANT, IDENTITY.email)).resolves.toEqual(IDENTITY);

    // One context for ensure_loaded, one for the registry update.
    expect(destroys).toHaveLength(2);
    for (const destroy of destroys) expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the update context when updating the registry fails', async () => {
    const { resolver, destroys } = build_resolver({
      registry_repo: { update: vi.fn().mockRejectedValue(new Error('update failed')) },
    });

    await expect(resolver.resolve_user(TENANT, IDENTITY.email)).rejects.toThrow('update failed');

    expect(destroys).toHaveLength(2);
    for (const destroy of destroys) expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the load context when loading the registry fails', async () => {
    const { resolver, destroys } = build_resolver({
      registry_repo: { load: vi.fn().mockRejectedValue(new Error('load failed')) },
    });

    await expect(resolver.resolve_user(TENANT, IDENTITY.email)).rejects.toThrow('load failed');

    expect(destroys).toHaveLength(1);
    expect(destroys[0]).toHaveBeenCalledTimes(1);
  });
});
