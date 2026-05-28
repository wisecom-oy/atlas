/**
 * Type definitions for Microsoft Graph API service-specific throttling limits.
 * Each pool uses a different cost model and enforcement scope.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits
 */

/**
 * Throttling limits for the Outlook / Exchange Online service pool.
 *
 * Scope: per app ID per mailbox. Limits for one mailbox are completely
 * independent of limits for any other mailbox.
 *
 * Cost model: flat -- every request counts as 1, regardless of endpoint or HTTP method.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 */
export interface OutlookServiceLimits {
  readonly pool: 'outlook';
  readonly scope: 'per_app_per_mailbox';
  readonly cost_model: 'flat';
  /** Maximum API requests per rolling window. Default: 10,000. */
  readonly requests_per_window: number;
  /** Window duration in milliseconds. Default: 600,000 (10 minutes). */
  readonly window_duration_ms: number;
  /** Maximum concurrent in-flight requests per mailbox. Default: 4. */
  readonly max_concurrent_requests: number;
  /** Maximum upload body bytes per upload window (POST/PATCH/PUT). Default: 157,286,400 (150 MB). */
  readonly upload_bytes_per_window: number;
  /** Upload window duration in milliseconds. Default: 300,000 (5 minutes). */
  readonly upload_window_duration_ms: number;
}

/**
 * Throttling limits for the SharePoint / OneDrive service pool.
 *
 * Scope: per app per tenant. All API calls to SharePoint and OneDrive from
 * a given app registration share one quota bucket per tenant, regardless of
 * the number of sites, drives, or users targeted.
 *
 * Cost model: resource units (RU). Each Graph API request has a predetermined
 * RU cost (1, 2, or 5) depending on the operation type. The atlas connector
 * should record the appropriate `resource_units` value for each call.
 *
 * Limits scale with the tenant's Microsoft 365 license count. The
 * `resource_units_per_minute` and `resource_units_per_day` fields hold a
 * tier lookup keyed by license-count range strings.
 *
 * @see https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online
 */
export interface SharePointServiceLimits {
  readonly pool: 'sharepoint_onedrive';
  readonly scope: 'per_app_per_tenant';
  readonly cost_model: 'resource_units';
  /**
   * Per-app-per-tenant resource unit limits per minute, keyed by license-count range.
   * Example keys: '0-1000', '1001-5000', '5001-15000', '15001-50000', '50000+'
   */
  readonly resource_units_per_minute: Record<string, number>;
  /**
   * Per-app-per-tenant resource unit limits per 24 hours, keyed by license-count range.
   */
  readonly resource_units_per_day: Record<string, number>;
  /**
   * Conservative safe estimate for cost tracking when the exact operation cost
   * is unknown. Microsoft recommends assuming 2 RU/request on average.
   */
  readonly default_cost_per_request: number;
  /** Delta requests with a token cost 1 RU (efficient incremental scan). */
  readonly delta_with_token_cost: number;
  /** Delta requests without a token cost 2 RU (full enumeration). */
  readonly delta_without_token_cost: number;
  /** Per-app per-tenant ingress limit per hour in bytes. */
  readonly upload_bytes_per_hour: number;
}

/**
 * Throttling limits for the Identity / Directory service pool (Microsoft Entra ID).
 *
 * Scope: per app per tenant, plus a global per-app limit.
 * Cost model: resource units via token-bucket algorithm. Each operation has a
 * base RU cost; query parameters like `$select` and `$expand` modify the cost.
 *
 * The per-app-per-tenant limit scales with tenant size (S/M/L).
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits
 */
export interface IdentityServiceLimits {
  readonly pool: 'identity';
  readonly scope: 'per_app_per_tenant';
  readonly cost_model: 'resource_units';
  /**
   * Per-app-per-tenant resource unit limits per 10 seconds, keyed by tenant size tier.
   * Tier definitions: S = under 50 users, M = 50-500 users, L = over 500 users.
   * Keys: 'S', 'M', 'L'
   */
  readonly resource_units_per_10s: Record<string, number>;
  /** Global per-app resource unit limit per 20 seconds across all tenants. */
  readonly resource_units_per_20s_global: number;
  /**
   * Base RU cost for GET /users (list operation).
   * Can be reduced by 1 with $select.
   */
  readonly users_list_cost: number;
  /**
   * Base RU cost for GET /users/{id} (single-item lookup).
   * Can be reduced by 1 with $select.
   */
  readonly user_get_cost: number;
  /**
   * Default base RU cost for any identity path not explicitly listed
   * in Microsoft's cost table. Read operations = 1, write operations = 1 read + 1 write.
   */
  readonly default_read_cost: number;
}

/** Combined limits for all three Microsoft Graph service pools used by Atlas. */
export interface GraphServiceLimits {
  readonly outlook: OutlookServiceLimits;
  readonly sharepoint_onedrive: SharePointServiceLimits;
  readonly identity: IdentityServiceLimits;
}
