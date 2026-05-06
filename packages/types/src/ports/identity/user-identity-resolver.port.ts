export interface ResolvedUserIdentity {
  readonly object_id: string;
  readonly display_name: string;
  readonly email: string;
}

export interface UserIdentityResolver {
  /** Resolves an email address or UPN to the user's Entra ID object ID. */
  resolve_user(tenant_id: string, email: string): Promise<ResolvedUserIdentity>;
  /** Batch resolves multiple emails to object IDs. */
  resolve_users(tenant_id: string, emails: string[]): Promise<ResolvedUserIdentity[]>;
  /** Reverse lookup: resolves an object ID back to the full identity (email + display name). */
  resolve_by_object_id(
    tenant_id: string,
    object_id: string,
  ): Promise<ResolvedUserIdentity | undefined>;
}
