import type { Context, Middleware } from '@microsoft/microsoft-graph-client';
import { RequestNotSentError, get_active_graph_attempt } from '@/graph-attempt';

/**
 * Hands each request sent inside a `with_graph_retry` attempt the attempt's abort signal, so the
 * request closes when its attempt times out or is cancelled instead of staying open beside the
 * retry (issue #888) and holding the process open after the run (issue #875).
 *
 * Only the attempt can close the request: every backup read used to take a zero-argument closure
 * and pass no signal, so the abort reached no socket. A read gets the signal that fires on the
 * timeout or on Ctrl+C. A write gets the one that fires only on the timeout, so a write already on
 * the wire finishes on Ctrl+C. A signal the call site set itself with `.option('signal', ...)`
 * is kept as it is.
 */
export class GraphAttemptSignalMiddleware implements Middleware {
  private _next?: Middleware;

  /**
   * Sets the attempt's signal on the request when it has none, then sends it. A request whose
   * attempt has already ended is not sent at all.
   */
  async execute(context: Context): Promise<void> {
    const attempt = get_active_graph_attempt();
    if (attempt?.send_signal.aborted === true) {
      throw new RequestNotSentError(attempt.send_signal.reason);
    }
    if (attempt !== undefined && context.options?.signal == null) {
      context.options = {
        ...context.options,
        signal: attempt.request_signal(context.options?.method),
      };
    }
    await this._next?.execute(context);
  }

  setNext(next: Middleware): void {
    this._next = next;
  }
}
