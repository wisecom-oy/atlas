import { describe, it, expect, vi } from 'vitest';
import type {
  IdentityRegistry,
  IdentityRegistryEntry,
  IdentityRegistryRepository,
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

function make_graph_resolver(overrides: Partial<UserIdentityResolver> = {}): UserIdentityResolver {
  return {
    resolve_user: vi.fn().mockRejectedValue(new Error('Not found')),
    resolve_users: vi.fn().mockResolvedValue([]),
    resolve_by_object_id: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function make_registry_repo(initial_registry?: IdentityRegistry): IdentityRegistryRepository {
  return {
    load: vi.fn().mockResolvedValue(initial_registry ?? undefined),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function make_ctx_factory(): TenantContextFactory {
  return {
    create: vi.fn().mockResolvedValue({ destroy: vi.fn() } as TenantContext),
  };
}

function make_entry(
  email: string,
  object_id: string,
  status: 'active' | 'recycled' = 'active',
): IdentityRegistryEntry {
  return {
    object_id,
    email: email.toLowerCase(),
    display_name: `User ${email}`,
    registered_at: '2025-01-01T00:00:00.000Z',
    status,
  };
}

function build_resolver(params: { graph?: UserIdentityResolver; registry?: IdentityRegistry }): {
  resolver: CachingIdentityResolver;
  registry_repo: IdentityRegistryRepository;
  graph: UserIdentityResolver;
} {
  const graph = params.graph ?? make_graph_resolver();
  const registry_repo = make_registry_repo(params.registry);
  const ctx_factory = make_ctx_factory();

  const resolver = new CachingIdentityResolver(graph, registry_repo, ctx_factory);

  return { resolver, registry_repo, graph };
}

const TENANT = 'tenant-abc';

describe('CachingIdentityResolver', () => {
  describe('resolve_user - Graph success, fresh user', () => {
    it('registers a new entry and returns the identity', async () => {
      const graph_identity: ResolvedUserIdentity = {
        object_id: 'obj-111',
        display_name: 'Alice',
        email: 'alice@company.com',
      };
      const graph = make_graph_resolver({
        resolve_user: vi.fn().mockResolvedValue(graph_identity),
      });
      const { resolver, registry_repo } = build_resolver({ graph });

      const result = await resolver.resolve_user(TENANT, 'Alice@Company.com');

      expect(result.object_id).toBe('obj-111');
      expect(result.display_name).toBe('Alice');
      expect(result.email).toBe('alice@company.com');
      expect(registry_repo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolve_user - Graph success, known user', () => {
    it('returns result without re-registering if object_id matches', async () => {
      const existing = make_entry('alice@company.com', 'obj-111');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [existing] };

      const graph_identity: ResolvedUserIdentity = {
        object_id: 'obj-111',
        display_name: 'Alice Updated',
        email: 'alice@company.com',
      };
      const graph = make_graph_resolver({
        resolve_user: vi.fn().mockResolvedValue(graph_identity),
      });
      const { resolver, registry_repo } = build_resolver({ graph, registry });

      const result = await resolver.resolve_user(TENANT, 'alice@company.com');

      expect(result.object_id).toBe('obj-111');
      expect(registry_repo.save).not.toHaveBeenCalled();
    });
  });

  describe('resolve_user - email recycling detection', () => {
    it('marks old entry as recycled and registers new entry', async () => {
      const old_user = make_entry('john@company.com', 'obj-old-john');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [old_user] };

      const new_identity: ResolvedUserIdentity = {
        object_id: 'obj-new-john',
        display_name: 'John Smith II',
        email: 'john@company.com',
      };
      const graph = make_graph_resolver({
        resolve_user: vi.fn().mockResolvedValue(new_identity),
      });
      const { resolver, registry_repo } = build_resolver({ graph, registry });

      const result = await resolver.resolve_user(TENANT, 'john@company.com');

      expect(result.object_id).toBe('obj-new-john');
      expect(registry_repo.save).toHaveBeenCalled();

      const saved_registry = (registry_repo.save as ReturnType<typeof vi.fn>).mock.calls;
      const last_save = saved_registry[saved_registry.length - 1][1] as IdentityRegistry;
      const old_entry = last_save.entries.find((e) => e.object_id === 'obj-old-john');
      const new_entry = last_save.entries.find((e) => e.object_id === 'obj-new-john');

      expect(old_entry?.status).toBe('recycled');
      expect(new_entry?.status).toBe('active');
    });

    it('handles multiple recyclings of the same email', async () => {
      const first_user = make_entry('shared@company.com', 'obj-1', 'recycled');
      const second_user = make_entry('shared@company.com', 'obj-2');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [first_user, second_user] };

      const third_identity: ResolvedUserIdentity = {
        object_id: 'obj-3',
        display_name: 'Third Person',
        email: 'shared@company.com',
      };
      const graph = make_graph_resolver({
        resolve_user: vi.fn().mockResolvedValue(third_identity),
      });
      const { resolver, registry_repo } = build_resolver({ graph, registry });

      const result = await resolver.resolve_user(TENANT, 'shared@company.com');

      expect(result.object_id).toBe('obj-3');
      const saved_registry = (registry_repo.save as ReturnType<typeof vi.fn>).mock.calls;
      const last_save = saved_registry[saved_registry.length - 1][1] as IdentityRegistry;
      const active_entries = last_save.entries.filter(
        (e) => e.email === 'shared@company.com' && e.status === 'active',
      );
      expect(active_entries).toHaveLength(1);
      expect(active_entries[0].object_id).toBe('obj-3');
    });
  });

  describe('resolve_user - Graph failure, cached fallback', () => {
    it('returns cached identity when Graph is unavailable and user was previously backed up', async () => {
      const cached = make_entry('deleted-user@company.com', 'obj-deleted');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [cached] };
      const graph = make_graph_resolver();
      const { resolver } = build_resolver({ graph, registry });

      const result = await resolver.resolve_user(TENANT, 'deleted-user@company.com');

      expect(result.object_id).toBe('obj-deleted');
      expect(result.email).toBe('deleted-user@company.com');
    });

    it('does not return recycled entries as fallback', async () => {
      const recycled = make_entry('old@company.com', 'obj-recycled', 'recycled');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [recycled] };
      const graph = make_graph_resolver();
      const { resolver } = build_resolver({ graph, registry });

      await expect(resolver.resolve_user(TENANT, 'old@company.com')).rejects.toThrow(
        'Cannot resolve "old@company.com"',
      );
    });
  });

  describe('resolve_user - Graph failure, no cache', () => {
    it('throws descriptive error when user never backed up', async () => {
      const { resolver } = build_resolver({});

      await expect(resolver.resolve_user(TENANT, 'unknown@company.com')).rejects.toThrow(
        'Cannot resolve "unknown@company.com"',
      );
    });
  });

  describe('resolve_by_object_id', () => {
    it('returns cached identity by object_id', async () => {
      const entry = make_entry('bob@company.com', 'obj-bob');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [entry] };
      const { resolver } = build_resolver({ registry });

      const result = await resolver.resolve_by_object_id(TENANT, 'obj-bob');

      expect(result?.email).toBe('bob@company.com');
      expect(result?.object_id).toBe('obj-bob');
    });

    it('falls back to Graph when object_id not in cache', async () => {
      const graph_result: ResolvedUserIdentity = {
        object_id: 'obj-new',
        display_name: 'New User',
        email: 'new@company.com',
      };
      const graph = make_graph_resolver({
        resolve_by_object_id: vi.fn().mockResolvedValue(graph_result),
      });
      const { resolver } = build_resolver({ graph });

      const result = await resolver.resolve_by_object_id(TENANT, 'obj-new');

      expect(result?.email).toBe('new@company.com');
      expect(graph.resolve_by_object_id).toHaveBeenCalledWith(TENANT, 'obj-new');
    });

    it('returns undefined when neither cache nor Graph has it', async () => {
      const { resolver } = build_resolver({});

      const result = await resolver.resolve_by_object_id(TENANT, 'obj-nonexistent');

      expect(result).toBeUndefined();
    });
  });

  describe('email normalization', () => {
    it('normalizes email case for cache lookups', async () => {
      const entry = make_entry('alice@company.com', 'obj-alice');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [entry] };
      const graph = make_graph_resolver();
      const { resolver } = build_resolver({ graph, registry });

      const result = await resolver.resolve_user(TENANT, 'ALICE@Company.COM');

      expect(result.object_id).toBe('obj-alice');
    });

    it('trims whitespace from email input', async () => {
      const entry = make_entry('bob@company.com', 'obj-bob');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [entry] };
      const graph = make_graph_resolver();
      const { resolver } = build_resolver({ graph, registry });

      const result = await resolver.resolve_user(TENANT, '  bob@company.com  ');

      expect(result.object_id).toBe('obj-bob');
    });
  });

  describe('registry loading and persistence', () => {
    it('only loads registry once per tenant (caches in memory)', async () => {
      const entry = make_entry('user@company.com', 'obj-1');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [entry] };
      const graph = make_graph_resolver();
      const { resolver, registry_repo } = build_resolver({ graph, registry });

      await resolver.resolve_user(TENANT, 'user@company.com');
      await resolver.resolve_user(TENANT, 'user@company.com');

      expect(registry_repo.load).toHaveBeenCalledTimes(1);
    });

    it('reloads when tenant changes', async () => {
      const entry = make_entry('user@company.com', 'obj-1');
      const registry: IdentityRegistry = { tenant_id: TENANT, entries: [entry] };
      const graph = make_graph_resolver();
      const { resolver, registry_repo } = build_resolver({ graph, registry });

      await resolver.resolve_user(TENANT, 'user@company.com');
      await resolver.resolve_user('other-tenant', 'user@company.com').catch(() => {});

      expect(registry_repo.load).toHaveBeenCalledTimes(2);
    });
  });
});
