/** Microsoft Graph credentials of a tenant a restore can write into. */
export interface AtlasTenantConfig {
  /** Microsoft Entra tenant: a GUID or a `*.onmicrosoft.com` domain. */
  readonly tenantId: string;
  /** Application (client) ID of the app registration in that tenant. */
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * A tenant handle returned by `createTenant`, passed to a restore method as `targetTenant` to
 * write the restore into that tenant. The client secret is held by the SDK, not by this object,
 * so logging or serialising the handle never prints it.
 */
export interface AtlasTenant {
  readonly tenantId: string;
  readonly clientId: string;
  /** Requests a Graph token with these credentials; throws `AuthError` when Entra ID refuses. */
  validate(): Promise<void>;
}

/** The restore option that writes into another tenant. */
export interface TargetTenantOption {
  /**
   * Writes the restore through this tenant's Graph credentials. The backup is still read and
   * decrypted with the instance's storage and passphrase, and the restore's explicit target
   * option is required, because object IDs differ between tenants.
   */
  readonly targetTenant?: AtlasTenant;
}
