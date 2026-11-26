import { vi } from 'vitest';
import type {
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { InMemoryIdentityRegistryRepository } from '@wisecom/atlas-types/testing/in-memory-identity-registry';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

export const TENANT = 'tenant-abc';

/** The address the registry knows, as an earlier backup recorded it. */
export const KNOWN_ADDRESS = 'john.doe@example.com';

/** The registry's identity for {@link KNOWN_ADDRESS}. */
export const STORED_JOHN: ResolvedUserIdentity = {
  object_id: 'oid-stored-john',
  display_name: 'John Doe',
  email: KNOWN_ADDRESS,
};

/** A Graph SDK error carrying an HTTP status, the shape the resolver branches on. */
export function graph_error(status_code: number): Error {
  return Object.assign(new Error(`Graph ${status_code}`), { statusCode: status_code });
}

/** A resolver whose registry holds {@link STORED_JOHN} and whose Graph lookup is `resolve_user`. */
export function resolver_with_graph(
  resolve_user: UserIdentityResolver['resolve_user'],
): CachingIdentityResolver {
  const graph: UserIdentityResolver = {
    resolve_user: vi.fn(resolve_user),
    resolve_by_object_id: vi.fn().mockResolvedValue(undefined),
  };
  const repo = new InMemoryIdentityRegistryRepository({
    tenant_id: TENANT,
    entries: [{ ...STORED_JOHN, registered_at: '2026-01-01T00:00:00.000Z', status: 'active' }],
  });
  const create = vi.fn(async () => ({ destroy: vi.fn() }) as unknown as TenantContext);
  const factory: TenantContextFactory = {
    create,
    create_readonly: create,
    create_storage_only: create,
  };
  return new CachingIdentityResolver(graph, repo, factory, { tenant_id: TENANT });
}

/** Collects what the resolver prints at warning level, the default log level's loudest line. */
export function capture_warnings(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return lines;
}
