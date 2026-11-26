import type {
  ResolvedUserIdentity,
  UserIdentityResolver,
  UserLookupPurpose,
} from '@wisecom/atlas-types';

/**
 * Mirrors the CLI: an owner containing `@` is an email and is resolved to an Entra object ID,
 * anything else already is one. Without this the same input addresses a non-existent owner and
 * the call returns an empty result instead of failing.
 *
 * `purpose` is `stored_backups` for a method that only reads backups already in storage, so the
 * identity registry answers for a known address when Graph is slow or down (issue #887).
 */
export async function resolve_owner_identity(
  identity: UserIdentityResolver,
  tenant_id: string,
  owner: string,
  purpose: UserLookupPurpose = 'microsoft_365',
): Promise<ResolvedUserIdentity | undefined> {
  if (!owner.includes('@')) return undefined;
  return await identity.resolve_user(tenant_id, owner, { purpose });
}

/** Returns the Entra object ID for an owner input, passing object IDs through unchanged. */
export async function resolve_owner_object_id(
  identity: UserIdentityResolver,
  tenant_id: string,
  owner: string,
  purpose: UserLookupPurpose = 'microsoft_365',
): Promise<string> {
  return (await resolve_owner_identity(identity, tenant_id, owner, purpose))?.object_id ?? owner;
}
