/**
 * Official Microsoft Graph API service throttling limits.
 *
 * Microsoft Graph enforces independent throttling pools per service. Consuming
 * quota in the Outlook pool has no effect on the SharePoint/OneDrive or
 * Identity pool for the same tenant. This is the single source of truth for
 * all Graph API limit values used across Atlas.
 *
 * Each service pool has a different cost model and enforcement scope:
 *
 * - Outlook: flat (1 req = 1), per app per mailbox
 * - SharePoint/OneDrive: resource units (1-5 RU/req), per app per tenant, scales with license count
 * - Identity: resource units (1-5 RU/req), per app per tenant, scales with tenant user count
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 * @see https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits
 *
 * Verified: 2026-05-28
 */

import type { GraphServiceLimits } from './graph-service-limits';

export const GRAPH_SERVICE_LIMITS: GraphServiceLimits = Object.freeze({
  /**
   * Outlook / Exchange Online service pool.
   * Scope: per app ID per mailbox.
   * Cost model: flat -- every request = 1 regardless of endpoint.
   * Source: https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
   */
  outlook: Object.freeze({
    pool: 'outlook' as const,
    scope: 'per_app_per_mailbox' as const,
    cost_model: 'flat' as const,

    // 10,000 API requests in a 10-minute period (v1.0 and beta endpoints)
    requests_per_window: 10_000,
    window_duration_ms: 10 * 60 * 1_000,

    // Maximum concurrent in-flight requests per mailbox
    max_concurrent_requests: 4,

    // 150 MB upload (PATCH, POST, PUT body) in a 5-minute period
    upload_bytes_per_window: 150 * 1024 * 1024,
    upload_window_duration_ms: 5 * 60 * 1_000,
  }),

  /**
   * SharePoint / OneDrive service pool.
   * Scope: per app per tenant (shared across all sites, drives, and users).
   * Cost model: resource units. Each Graph API request has a predetermined cost.
   * Limits scale with the tenant's Microsoft 365 license count.
   * Source: https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online
   *
   * Resource unit costs per Graph request:
   *   1 RU -- single-item GET (by ID), delta with token
   *   2 RU -- multi-item list/search, delta without token
   *   5 RU -- permission operations, $expand=permissions
   * Microsoft reserves the right to change these costs.
   */
  sharepoint_onedrive: Object.freeze({
    pool: 'sharepoint_onedrive' as const,
    scope: 'per_app_per_tenant' as const,
    cost_model: 'resource_units' as const,

    // Per-app-per-tenant resource unit limits per minute, by license count tier
    resource_units_per_minute: Object.freeze({
      '0-1000': 1_250,
      '1001-5000': 2_500,
      '5001-15000': 3_750,
      '15001-50000': 5_000,
      '50000+': 6_250,
    }),

    // Per-app-per-tenant resource unit limits per 24 hours, by license count tier
    resource_units_per_day: Object.freeze({
      '0-1000': 1_200_000,
      '1001-5000': 2_400_000,
      '5001-15000': 3_600_000,
      '15001-50000': 4_800_000,
      '50000+': 6_000_000,
    }),

    // Safe conservative estimate: Microsoft recommends assuming 2 RU/request on average
    default_cost_per_request: 2,

    // Delta with a saved token costs 1 RU (efficient incremental scan)
    delta_with_token_cost: 1,

    // Delta without a token costs 2 RU (full enumeration)
    delta_without_token_cost: 2,

    // 400 GB ingress per hour per app per tenant
    upload_bytes_per_hour: 400 * 1024 * 1024 * 1024,
  }),

  /**
   * Identity / Directory service pool (Microsoft Entra ID).
   * Scope: per app per tenant, plus a global per-app limit across all tenants.
   * Cost model: resource units via token-bucket algorithm.
   * Limits scale with tenant user count (S/M/L tiers).
   * Source: https://learn.microsoft.com/en-us/graph/throttling-limits#identity-and-access-service-limits
   *
   * Base resource unit costs for operations Atlas uses:
   *   GET /users             -- 2 RU (reduced by 1 with $select => ~1 RU in practice)
   *   GET /users/{id}        -- 1 RU (default, reduced by 1 with $select => ~1 RU)
   *   GET /reports/...       -- 1 RU (default)
   *   POST/PATCH/PUT/DELETE  -- 1 RU read + 1 write (Atlas only reads)
   *
   * Cost modifiers (applied on top of base cost):
   *   $select  => -1 RU
   *   $expand  => +1 RU
   *   $top < 20 => -1 RU
   */
  identity: Object.freeze({
    pool: 'identity' as const,
    scope: 'per_app_per_tenant' as const,
    cost_model: 'resource_units' as const,

    // Per-app-per-tenant resource unit limits per 10 seconds, by tenant user count tier
    // S = under 50 users, M = 50-500 users, L = over 500 users
    resource_units_per_10s: Object.freeze({
      S: 3_500,
      M: 5_000,
      L: 8_000,
    }),

    // Global per-app limit across all tenants: 150,000 RU per 20 seconds
    resource_units_per_20s_global: 150_000,

    // GET /users (list) base cost = 2 RU; with $select = ~1 RU in practice
    users_list_cost: 2,

    // GET /users/{id} (single lookup) base cost = 1 RU (not in explicit table = default)
    user_get_cost: 1,

    // Default base cost for any identity path not listed in Microsoft's cost table
    default_read_cost: 1,
  }),
});
