/**
 * How a create request sent once ended, when it is not retried: refused, or with an outcome nobody
 * knows (issue #893).
 *
 * A create POST, or a drive PUT under `rename` or `fail`, is sent once because Graph can commit it
 * and still answer `5xx`, or answer after the attempt's deadline, and repeating it would leave a
 * second copy. Thrown unchanged, such a failure read exactly like a `400` Graph refused, so a
 * restore could not tell the operator which items to check in the target before a rerun.
 */
import {
  CreateOutcomeUnknownError,
  GraphUnavailableError,
  ThrottledError,
} from '@wisecom/atlas-types';
import { RequestNotSentError } from '@/graph-attempt';
import { describe_graph_error } from '@/graph-error-description';
import { is_network_error } from '@/graph-network-error';
import { is_permanent_item_error } from '@/graph-permanent-item-errors';
import { is_retryable_graph_status } from '@/graph-retryable-status';
import { is_throttle_response } from '@/graph-throttle-response';
import { is_transient_token_request_error } from '@/graph-token-failure';
import { is_unreadable_success_body } from '@/graph-unreadable-body';

/**
 * The `CreateOutcomeUnknownError` for a failed attempt of a create sent once, or undefined when the
 * failure leaves no doubt that nothing was created, or is the run's cancellation.
 */
export function send_once_outcome_unknown(
  err: unknown,
  cancel_signal: AbortSignal | undefined,
): CreateOutcomeUnknownError | undefined {
  if (is_cancellation(err, cancel_signal) || !leaves_create_outcome_unknown(err)) return undefined;
  return new CreateOutcomeUnknownError(describe_graph_error(err), { cause: err });
}

/**
 * Throws `CreateOutcomeUnknownError` when a failed attempt of a call that is not idempotent may
 * have been committed. An idempotent call is repeated instead, so this does nothing for one.
 */
export function throw_if_send_once_outcome_unknown(
  err: unknown,
  idempotent: boolean,
  cancel_signal: AbortSignal | undefined,
): void {
  if (idempotent) return;
  const unknown = send_once_outcome_unknown(err, cancel_signal);
  if (unknown !== undefined) throw unknown;
}

/**
 * Whether a create sent once may have been committed although its attempt failed: a `408`, `500`,
 * `502`, `504`, a `503` without `Retry-After`, a `509`, a `2xx` whose body did not parse, a timeout,
 * or a dropped connection. A throttle response (`429`, or `503` with `Retry-After`) is Graph refusing
 * before processing, and is retried. A request never sent, a failed token request, an inner call's
 * exhausted budget and every other `4xx` created nothing.
 */
export function leaves_create_outcome_unknown(err: unknown): boolean {
  if (err instanceof RequestNotSentError || is_transient_token_request_error(err)) return false;
  if (err instanceof ThrottledError || err instanceof GraphUnavailableError) return false;
  if (is_throttle_response(err) || is_permanent_item_error(err)) return false;
  return (
    is_retryable_graph_status(status_code_of(err)) ||
    is_network_error(err) ||
    is_unreadable_success_body(err)
  );
}

/** Whether `err` is the run's cancellation, which ends the call however the request went. */
function is_cancellation(err: unknown, cancel_signal: AbortSignal | undefined): boolean {
  if (cancel_signal?.aborted !== true) return false;
  const reason: unknown = cancel_signal.reason;
  return err === reason || (err instanceof Error && err.cause === reason);
}

/** The HTTP status a Graph or network error carries, or undefined when it carries none. */
function status_code_of(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'statusCode' in err
    ? err.statusCode
    : undefined;
}
