import { GRAPH_SERVICE_LIMITS as INTERNAL_GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import type { GraphServiceLimits as InternalGraphServiceLimits } from '@wisecom/atlas-types';
import type { OperationCost as InternalOperationCost } from '@wisecom/atlas-types';
import { camelize, type Camelize } from '@wisecom/atlas-types/public/case-convert';
import { get_graph_cost as read_internal_graph_cost } from '@wisecom/atlas-core/services/shared/graph-request-context';

/**
 * The published Graph limits, per pool, in the public camelCase form.
 *
 * The pool names are keys, not fields: `outlook`, `sharepoint_onedrive` and `identity` are the
 * same identifiers an `OperationCost` reports under in `byService`, so only the leaf limit fields
 * are converted. Camelising the root would give `GRAPH_SERVICE_LIMITS.sharepointOnedrive` next to
 * `cost.byService.sharepoint_onedrive`, and a caller reading a pool name off a cost and indexing
 * the limits with it would get `undefined` for the drive pool.
 */
export type GraphServiceLimits = {
  readonly [Pool in keyof InternalGraphServiceLimits]: Camelize<InternalGraphServiceLimits[Pool]>;
};

export const GRAPH_SERVICE_LIMITS: GraphServiceLimits = Object.fromEntries(
  Object.entries(INTERNAL_GRAPH_SERVICE_LIMITS).map(([pool, limits]) => [pool, camelize(limits)]),
) as GraphServiceLimits;

/** The Graph cost of one operation, in the public camelCase form. */
export type OperationCost = Camelize<InternalOperationCost>;

/**
 * Cost attributed to a single service pool.
 *
 * `NonNullable` because `byService` is partial: only pools the operation actually used appear, so
 * the indexed access includes `undefined` and the name would otherwise describe a cost that might
 * not be a cost.
 */
export type ServicePoolCost = NonNullable<
  OperationCost['byService'][keyof OperationCost['byService']]
>;

/**
 * Reads the Graph cost burned before a failed operation threw.
 *
 * Wrapped rather than re-exported, because the cost object it returns is part of the public
 * surface and has to arrive camelCase like every other result (issue #45).
 */
export function getGraphCost(err: unknown): OperationCost | undefined {
  const cost = read_internal_graph_cost(err);
  return cost === undefined ? undefined : camelize(cost);
}
