import { GRAPH_SERVICE_LIMITS as INTERNAL_GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import type { GraphServiceLimits, OperationCost } from '@wisecom/atlas-types';
import { camelize, type Camelize } from '@wisecom/atlas-types/public/case-convert';
import { get_graph_cost as read_internal_graph_cost } from '@wisecom/atlas-core/services/shared/graph-request-context';

/**
 * The published Graph limits, in the public camelCase form.
 *
 * Converted from the internal constant rather than declared twice: two copies of a limits table
 * drift, and the one that drifts is the one nobody reads. Pool names (`outlook`,
 * `sharepoint_onedrive`, `identity`) are identifiers rather than field names and are preserved,
 * so `GRAPH_SERVICE_LIMITS.sharepoint_onedrive` still addresses the pool an `OperationCost`
 * reports under.
 */
export const GRAPH_SERVICE_LIMITS: Camelize<GraphServiceLimits> = camelize(
  INTERNAL_GRAPH_SERVICE_LIMITS,
);

/**
 * Reads the Graph cost burned before a failed operation threw.
 *
 * Wrapped rather than re-exported, because the cost object it returns is part of the public
 * surface and has to arrive camelCase like every other result (issue #45).
 */
export function getGraphCost(err: unknown): Camelize<OperationCost> | undefined {
  const cost = read_internal_graph_cost(err);
  return cost === undefined ? undefined : camelize(cost);
}
