/**
 * Type definitions for Microsoft Graph API service-specific throttling limits.
 * Each pool uses a different cost model and enforcement scope.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits
 */

/**
 * Outlook / Exchange Online service pool limits.
 * Scope: per app ID per mailbox.
 * Cost model: flat — every request = 1.
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 */
export interface OutlookServiceLimits {
  readonly pool: 'outlook';
  readonly scope: 'per_app_per_mailbox';
  readonly cost_model: 'flat';
  readonly requests_per_window: number;
  readonly window_duration_ms: number;
  readonly max_concurrent_requests: number;
  readonly upload_bytes_per_window: number;
  readonly upload_window_duration_ms: number;
}

/**
 * SharePoint / OneDrive service pool limits.
 * Scope: per app per tenant.
 * Cost model: resource units (1–5 RU/request, scales with tenant license count).
 * @see https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online
 */
export interface SharePointServiceLimits {
  readonly pool: 'sharepoint_onedrive';
  readonly scope: 'per_app_per_tenant';
  readonly cost_model: 'resource_units';
  readonly resource_units_per_minute: Record<string, number>;
  readonly resource_units_per_day: Record<string, number>;
  readonly default_cost_per_request: number;
  readonly delta_with_token_cost: number;
  readonly delta_without_token_cost: number;
  readonly upload_bytes_per_hour: number;
}

/**
 * Identity / Directory service pool limits (Microsoft Entra ID).
 * Scope: per app per tenant plus a global per-app limit.
 * Cost model: resource units via token-bucket algorithm.
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits
 */
export interface IdentityServiceLimits {
  readonly pool: 'identity';
  readonly scope: 'per_app_per_tenant';
  readonly cost_model: 'resource_units';
  readonly resource_units_per_10s: Record<string, number>;
  readonly resource_units_per_20s_global: number;
  readonly users_list_cost: number;
  readonly user_get_cost: number;
  readonly default_read_cost: number;
}

/** Combined limits for all three Microsoft Graph service pools used by Atlas. */
export interface GraphServiceLimits {
  readonly outlook: OutlookServiceLimits;
  readonly sharepoint_onedrive: SharePointServiceLimits;
  readonly identity: IdentityServiceLimits;
}
