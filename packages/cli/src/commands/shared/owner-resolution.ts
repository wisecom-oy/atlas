import type { Container } from 'inversify';
import { GRAPH_IDENTITY_RESOLVER_TOKEN, logger } from '@wisecom/atlas-core';
import type { UserIdentityResolver, UserLookupPurpose } from '@wisecom/atlas-types';
import { USER_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-types';

export interface ResolvedOwner {
  readonly object_id: string;
  readonly email?: string;
  readonly display_name?: string;
}

/**
 * Resolves the owner of a command that works on live Microsoft 365 data (backup, restore, status,
 * delete): an address is looked up through Graph first, and an object ID is used as given.
 */
export async function resolve_owner(
  container: Container,
  tenant_id: string,
  owner_input: string,
): Promise<ResolvedOwner> {
  const resolver = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
  return resolve_owner_with(resolver, tenant_id, owner_input, 'microsoft_365');
}

/**
 * Resolves the owner of a command that only reads stored backups (verify, list, save, stats). The
 * identity registry answers for an address it knows when Graph has not answered within a short
 * wait, so checking backups during a Graph outage is not held for the retry budget (issue #887).
 */
export async function resolve_stored_owner(
  container: Container,
  tenant_id: string,
  owner_input: string,
): Promise<ResolvedOwner> {
  const resolver = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
  return resolve_owner_with(resolver, tenant_id, owner_input, 'stored_backups');
}

/**
 * Resolves a restore target through Graph alone, never the identity registry. The target lives in
 * the tenant the Graph credentials belong to, which in a cross-tenant restore is not the backed-up
 * tenant whose registry the caching resolver reads and writes.
 */
export async function resolve_restore_target(
  container: Container,
  tenant_id: string,
  target_input: string,
): Promise<ResolvedOwner> {
  const graph = container.get<UserIdentityResolver>(GRAPH_IDENTITY_RESOLVER_TOKEN);
  return resolve_owner_with(graph, tenant_id, target_input, 'microsoft_365');
}

async function resolve_owner_with(
  resolver: UserIdentityResolver,
  tenant_id: string,
  owner_input: string,
  purpose: UserLookupPurpose,
): Promise<ResolvedOwner> {
  if (!owner_input.includes('@')) return { object_id: owner_input };
  const identity = await resolver.resolve_user(tenant_id, owner_input, { purpose });
  logger.info(`Resolved ${owner_input} -> ${identity.object_id} (${identity.display_name})`);
  return {
    object_id: identity.object_id,
    email: identity.email,
    display_name: identity.display_name,
  };
}
