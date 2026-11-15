import { describe, it, expect, vi } from 'vitest';
import type {
  IdentityRegistryRepository,
  ResolvedUserIdentity,
  TenantContext,
  TenantContextFactory,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { CachingIdentityResolver } from '@/adapters/identity/caching-identity-resolver.adapter';

// Issue #768: `verify` or `list` against a copy of the bucket, given an email owner and read-only
// credentials, must not fail because the identity registry cannot be written.

const TENANT = 'tenant-abc';
const JOHN: ResolvedUserIdentity = {
  object_id: 'oid-john',
  display_name: 'John Doe',
  email: 'john.doe@example.com',
};

function access_denied(): Error {
  return Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
}

function read_only_resolver(update: IdentityRegistryRepository['update']) {
  const context = { destroy: vi.fn() } as unknown as TenantContext;
  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn().mockResolvedValue(context),
  };
  const graph: UserIdentityResolver = {
    resolve_user: vi.fn().mockResolvedValue(JOHN),
    resolve_by_object_id: vi.fn(),
  };
  const repo: IdentityRegistryRepository = { load: vi.fn().mockResolvedValue(undefined), update };
  return new CachingIdentityResolver(graph, repo, factory, { tenant_id: TENANT });
}

describe('CachingIdentityResolver with read-only storage (issue #768)', () => {
  it('returns the Graph answer when the registry write is refused, logging at debug', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn');
    const resolver = read_only_resolver(vi.fn().mockRejectedValue(access_denied()));

    await expect(resolver.resolve_user(TENANT, JOHN.email)).resolves.toEqual(JOHN);

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('Access Denied'));
    expect(warn).not.toHaveBeenCalled();
    debug.mockRestore();
    warn.mockRestore();
  });

  it('tries the write again on the next lookup, since nothing was recorded', async () => {
    const update = vi.fn().mockRejectedValue(access_denied());
    const resolver = read_only_resolver(update);

    await resolver.resolve_user(TENANT, JOHN.email);
    await resolver.resolve_user(TENANT, JOHN.email);

    expect(update).toHaveBeenCalledTimes(2);
  });
});
