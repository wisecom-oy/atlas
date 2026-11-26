export interface ResolvedUserIdentity {
  readonly object_id: string;
  readonly display_name: string;
  readonly email: string;
}

/**
 * What the caller does with a resolved user, which decides when the identity registry may answer
 * in place of Microsoft Graph.
 *
 * - `microsoft_365`: the command works on the user's live data next (backup, restore, status,
 *   delete). Graph is asked first and waited for, so a recycled address maps to its current owner,
 *   and an exhausted Graph retry budget ends the lookup instead of falling back.
 * - `stored_backups`: the command only reads backups already in storage (verify, list, save,
 *   stats). A registry entry stands in when Graph has not answered within a short wait.
 */
export type UserLookupPurpose = 'microsoft_365' | 'stored_backups';

/** Options for {@link UserIdentityResolver.resolve_user}. */
export interface ResolveUserOptions {
  /** Defaults to `microsoft_365`. */
  readonly purpose?: UserLookupPurpose;
}

export interface UserIdentityResolver {
  /** Resolves an email address or UPN to the user's Entra ID object ID. */
  resolve_user(
    tenant_id: string,
    email: string,
    options?: ResolveUserOptions,
  ): Promise<ResolvedUserIdentity>;
  /** Reverse lookup: resolves an object ID back to the full identity (email + display name). */
  resolve_by_object_id(
    tenant_id: string,
    object_id: string,
  ): Promise<ResolvedUserIdentity | undefined>;
}
