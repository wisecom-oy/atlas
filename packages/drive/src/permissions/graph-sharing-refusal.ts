import type { DriveSharingRefusal } from '@wisecom/atlas-types';
import { describe_graph_error } from '@wisecom/atlas-m365-graph';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';

/** The text a Graph refusal carries, from the SDK error's message and raw body. */
function refusal_text(err: unknown): string {
  const record = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const message = err instanceof Error ? err.message : '';
  const body = typeof record.body === 'string' ? record.body : '';
  return `${message} ${body}`;
}

/**
 * Names why Graph refused a sharing write, from the answers observed on a live tenant:
 *
 * - `invite` for a principal that no longer exists, an unknown object id or an address outside the
 *   tenant: 400 `invalidRequest`, "One or more users could not be resolved".
 * - an anonymous link where the tenant forbids them: 403 `notAllowed`, inner code `sharingDisabled`.
 */
export function classify_sharing_refusal(err: unknown): DriveSharingRefusal {
  const text = refusal_text(err);
  if (/could not be resolved/i.test(text)) return 'principal_unresolved';
  if (/sharingDisabled|sharing has been disabled/i.test(text)) return 'sharing_disabled';
  return 'rejected';
}

/** A refusal outcome for `err`, rethrowing when the run was cancelled rather than refused. */
export function refusal_from_error(err: unknown): {
  status: 'refused';
  refusal: DriveSharingRefusal;
  message: string;
} {
  if (is_active_run_cancelled()) throw err;
  return {
    status: 'refused',
    refusal: classify_sharing_refusal(err),
    message: describe_graph_error(err),
  };
}
