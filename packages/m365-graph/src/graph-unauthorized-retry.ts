/**
 * When `with_graph_retry` repeats a Graph `401` (issue #861).
 *
 * Graph answers `401` when it does not accept the access token, and it can do so for a token Entra
 * ID has only just issued. The transport discards the rejected token as the answer arrives
 * (`GraphTokenRejectionMiddleware`), so one repeat goes out with a newly issued token. A `401` that
 * survives a new token is the credentials' or the tenant's problem and is final: repeating it
 * through the whole retry budget would only delay the report.
 */

/**
 * Graph's code for a token it did not accept: expired, not yet valid, or signed by a key it does not
 * trust. Graph checks the token before it routes the request to the workload, so a request answered
 * with this code was never processed.
 */
const INVALID_TOKEN_CODE = 'InvalidAuthenticationToken';

/** Whether `err` is Graph answering `401`. */
export function is_graph_unauthorized(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 401;
}

/**
 * Whether a failed attempt may be repeated once with a new token: a `401`, and none repeated yet in
 * this call. A write that is not idempotent is repeated only on `InvalidAuthenticationToken`, the
 * one `401` that proves Graph never processed it, so a repeat cannot store it twice.
 */
export function may_repeat_with_new_token(
  err: unknown,
  idempotent: boolean,
  new_token_tried: boolean,
): boolean {
  if (new_token_tried || !is_graph_unauthorized(err)) return false;
  return idempotent || graph_error_code(err) === INVALID_TOKEN_CODE;
}

/** One call's single repeat of a `401` with a new token. */
export class NewTokenRepeat {
  private claimed = false;

  /** Claims the call's one repeat for `err` when `may_repeat_with_new_token` allows it. */
  claim(err: unknown, idempotent: boolean): boolean {
    if (!may_repeat_with_new_token(err, idempotent, this.claimed)) return false;
    this.claimed = true;
    return true;
  }
}

function graph_error_code(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}
