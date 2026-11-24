/**
 * The Microsoft Graph throttling pools Atlas meters, as they appear in `OperationCost.by_service`,
 * in `GRAPH_SERVICE_LIMITS`, and in a throttle coordinator's `pool` argument.
 *
 * - `outlook`: Exchange Online mail, calendar, contacts. Scope: per app per mailbox.
 * - `sharepoint_onedrive`: SharePoint and OneDrive files and lists. Scope: per app per tenant.
 * - `identity`: Microsoft Entra ID users, groups, directory. Scope: per app per tenant.
 * - `teams`: Microsoft Teams teams, channels, and channel messages. Scope: per app per tenant.
 *
 * Imports nothing: the SDK publishes it through `@wisecom/atlas-sdk/contract` (issue #824).
 */
export const GRAPH_SERVICE_POOLS = Object.freeze([
  'outlook',
  'sharepoint_onedrive',
  'identity',
  'teams',
] as const);

/** One Graph throttling pool. See {@link GRAPH_SERVICE_POOLS}. */
export type GraphServicePool = (typeof GRAPH_SERVICE_POOLS)[number];
