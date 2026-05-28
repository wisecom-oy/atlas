/**
 * Official Microsoft Graph API service throttling limits.
 *
 * Single source of truth for all Graph API limit values used across Atlas.
 * Each pool is independent — consuming Outlook quota has no effect on the
 * SharePoint/OneDrive or Identity pool for the same tenant.
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
  outlook: Object.freeze({
    pool: 'outlook' as const,
    scope: 'per_app_per_mailbox' as const,
    cost_model: 'flat' as const,
    requests_per_window: 10_000,
    window_duration_ms: 10 * 60 * 1_000,
    max_concurrent_requests: 4,
    upload_bytes_per_window: 150 * 1024 * 1024,
    upload_window_duration_ms: 5 * 60 * 1_000,
  }),

  sharepoint_onedrive: Object.freeze({
    pool: 'sharepoint_onedrive' as const,
    scope: 'per_app_per_tenant' as const,
    cost_model: 'resource_units' as const,
    resource_units_per_minute: Object.freeze({
      '0-1000': 1_250,
      '1001-5000': 2_500,
      '5001-15000': 3_750,
      '15001-50000': 5_000,
      '50000+': 6_250,
    }),
    resource_units_per_day: Object.freeze({
      '0-1000': 1_200_000,
      '1001-5000': 2_400_000,
      '5001-15000': 3_600_000,
      '15001-50000': 4_800_000,
      '50000+': 6_000_000,
    }),
    default_cost_per_request: 2,
    delta_with_token_cost: 1,
    delta_without_token_cost: 2,
    upload_bytes_per_hour: 400 * 1024 * 1024 * 1024,
  }),

  identity: Object.freeze({
    pool: 'identity' as const,
    scope: 'per_app_per_tenant' as const,
    cost_model: 'resource_units' as const,
    resource_units_per_10s: Object.freeze({
      S: 3_500,
      M: 5_000,
      L: 8_000,
    }),
    resource_units_per_20s_global: 150_000,
    users_list_cost: 2,
    user_get_cost: 1,
    default_read_cost: 1,
  }),
});
