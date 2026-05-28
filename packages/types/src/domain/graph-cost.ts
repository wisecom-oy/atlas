/**
 * Microsoft Graph API cost tracking types.
 *
 * Microsoft Graph enforces separate, independent throttling pools per service.
 * Consuming quota in the Outlook pool does not affect the SharePoint/OneDrive
 * or Identity pool within the same tenant.
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits
 */

/**
 * Identifies which Microsoft Graph service pool an API request is charged against.
 *
 * - `outlook` -- Exchange Online mail, calendar, contacts. Scope: per app per mailbox.
 * - `sharepoint_onedrive` -- SharePoint and OneDrive files/lists. Scope: per app per tenant.
 * - `identity` -- Microsoft Entra ID users, groups, directory. Scope: per app per tenant.
 */
export type GraphServicePool = 'outlook' | 'sharepoint_onedrive' | 'identity';

/** Cost accumulated against a single service pool during one SDK operation. */
export interface ServicePoolCost {
  /** Number of API requests made against this pool. */
  readonly requests: number;
  /**
   * Resource units consumed. For the Outlook pool (flat cost model) this equals
   * `requests`. For SharePoint/OneDrive and Identity pools (resource-unit model)
   * each request may cost 1–5 RU depending on the operation.
   */
  readonly resource_units: number;
  /**
   * Total bytes sent in request bodies (POST/PATCH/PUT).
   * Relevant for the Outlook pool (150 MB / 5-min upload window).
   */
  readonly upload_bytes: number;
}

/**
 * Total cost of a single Atlas SDK method call across all service pools.
 * Returned as `graph_cost` on operation results when called through the SDK.
 */
export interface OperationCost {
  /** Sum of requests across all pools. */
  readonly requests_total: number;
  /**
   * Per-pool breakdown. Only pools that were actually used appear as keys.
   * A mail backup will typically have `outlook` and `identity` entries.
   */
  readonly by_service: Partial<Record<GraphServicePool, ServicePoolCost>>;
  /**
   * Request counts broken down by named operation type.
   * Keys are stable strings defined by Atlas connectors, e.g. `delta_sync`,
   * `fetch_attachments`, `list_folders`, `mailbox_exists`.
   */
  readonly requests_by_type: Record<string, number>;
  /** Wall-clock duration of the SDK operation in milliseconds. */
  readonly elapsed_ms: number;
}
