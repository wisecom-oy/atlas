import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphClientError } from '@microsoft/microsoft-graph-client';

/**
 * One attempt of a `with_graph_retry` call, as the requests it sends see it.
 *
 * The attempt runs inside an async context, so every request it sends can be torn down with it
 * without each call site passing a signal (issues #888, #875): the Graph client's attempt
 * middleware hands the signal to fetch, and the token provider stops waiting for a token the
 * attempt no longer needs (issue #889). A raw `fetch` inside an attempt reads the same signal with
 * `get_active_attempt_signal`.
 */

const _attempt = new AsyncLocalStorage<GraphAttempt>();

/** Methods that only read. Any other method is a write. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The signals that end an attempt early, besides its own timeout. */
export interface AttemptStopSignals {
  /** Cuts off a request already sent: the run's cancellation, unless the call completes writes. */
  readonly in_flight?: AbortSignal | undefined;
  /** Stops a request that is not sent yet: cancellation, an outage of the run, or both. */
  readonly before_send?: AbortSignal | undefined;
}

/**
 * The error a cancelled run rejects with: the signal's reason when it is an Error, otherwise an
 * Error carrying the reason as its `cause`, so the cancellation stays recognisable by identity.
 */
export function cancelled_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('The run was cancelled', { cause: reason });
}

/**
 * The abort signals of one attempt.
 *
 * - `signal` fires when the attempt times out or the run is cancelled (`in_flight`). A read in
 *   flight is cut off by it.
 * - `write_signal` fires only when the attempt times out. A write already sent finishes on
 *   Ctrl+C unless its call site passed `signal` itself, and is torn down at its timeout, so a
 *   timed-out write is never left open beside its retry (issue #624).
 * - `send_signal` fires on either, and also on `before_send`. Nothing is sent after it fires.
 */
export class GraphAttempt {
  private readonly expiry = new AbortController();
  private readonly cutoff = new AbortController();
  private readonly unsent = new AbortController();
  private token_wait: (() => Error) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private write_signal_handed_out = false;
  private released = false;

  constructor(private readonly stops: AttemptStopSignals) {
    stops.in_flight?.addEventListener('abort', this.on_in_flight_stop, { once: true });
    stops.before_send?.addEventListener('abort', this.on_before_send_stop, { once: true });
    if (stops.in_flight?.aborted) this.on_in_flight_stop();
    if (stops.before_send?.aborted) this.on_before_send_stop();
  }

  /** Fires on the attempt's timeout or the run's cancellation; handed to the attempt's `fn`. */
  get signal(): AbortSignal {
    return this.cutoff.signal;
  }

  /** Fires once nothing may be sent for this attempt any more. */
  get send_signal(): AbortSignal {
    return this.unsent.signal;
  }

  /** The signal a request of `method` is sent with when its call site passed none. */
  request_signal(method: string | undefined): AbortSignal {
    if (READ_METHODS.has((method ?? 'GET').toUpperCase())) return this.cutoff.signal;
    this.write_signal_handed_out = true;
    return this.expiry.signal;
  }

  /**
   * Starts the attempt's timeout. The returned promise rejects with the timeout error when it
   * fires, and every signal is then aborted with that error, after the rejection, so the caller
   * sees the timeout rather than the abort it causes.
   *
   * The timeout stays armed until `settle`, not only until the caller stops waiting, so a write a
   * cancelled run lets finish is still torn down at its timeout rather than left open.
   */
  arm_timeout(ms: number): Promise<never> {
    const { promise: expired, reject } = Promise.withResolvers<never>();
    // Cut off before it began, with no write to tear down: there is nothing to time.
    if (this.released) return expired;
    this.timer = setTimeout(() => {
      const timed_out = this.timeout_error();
      reject(timed_out);
      this.expire(timed_out);
    }, ms);
    return expired;
  }

  /** Ends the attempt once its work has settled: clears the timeout, detaches from the run. */
  settle(): void {
    clearTimeout(this.timer);
    this.release();
  }

  /**
   * Marks the attempt as waiting for its access token until the returned function is called.
   * `explain` builds the error a timeout during that wait rejects with instead of `ETIMEDOUT`.
   */
  begin_token_wait(explain: () => Error): () => void {
    this.token_wait = explain;
    return () => {
      if (this.token_wait === explain) this.token_wait = undefined;
    };
  }

  /**
   * The error the attempt's timeout rejects with: `ETIMEDOUT`, or the token request's own failure
   * when the attempt was still waiting for its token.
   */
  private timeout_error(): Error {
    return (
      this.token_wait?.() ??
      Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' as const })
    );
  }

  /** Ends the attempt on its timeout: aborts every signal with `timed_out`. */
  private expire(timed_out: Error): void {
    this.expiry.abort(timed_out);
    this.cutoff.abort(timed_out);
    this.unsent.abort(timed_out);
    this.release();
  }

  /** Detaches the attempt from the run's signals. */
  private release(): void {
    if (this.released) return;
    this.released = true;
    this.stops.in_flight?.removeEventListener('abort', this.on_in_flight_stop);
    this.stops.before_send?.removeEventListener('abort', this.on_before_send_stop);
  }

  /**
   * Cuts off the attempt's reads and anything unsent. With no write handed the timeout signal,
   * nothing is left for the timeout to tear down, so it is cleared rather than left holding the
   * process open.
   */
  private readonly on_in_flight_stop = (): void => {
    const reason = cancelled_error(this.stops.in_flight?.reason);
    this.cutoff.abort(reason);
    this.unsent.abort(reason);
    if (!this.write_signal_handed_out) this.settle();
  };

  private readonly on_before_send_stop = (): void => {
    this.unsent.abort(cancelled_error(this.stops.before_send?.reason));
  };
}

/** Runs `fn` as the body of `attempt`, so the requests it sends can read the attempt's signals. */
export function run_in_graph_attempt<T>(attempt: GraphAttempt, fn: () => Promise<T>): Promise<T> {
  return _attempt.run(attempt, fn);
}

/** The attempt the current async context belongs to, or undefined outside `with_graph_retry`. */
export function get_active_graph_attempt(): GraphAttempt | undefined {
  return _attempt.getStore();
}

/**
 * The signal a raw `fetch` inside a `with_graph_retry` attempt should pass, so a timed-out or
 * cancelled attempt closes it: the read signal for GET and HEAD, the timeout-only signal for a
 * write. Undefined outside an attempt.
 */
export function get_active_attempt_signal(method = 'GET'): AbortSignal | undefined {
  return _attempt.getStore()?.request_signal(method);
}

/**
 * A Graph request that was not sent because its attempt had ended first: it timed out, the run was
 * cancelled, or the run met an outage while the request waited for its token. `cause` is why.
 *
 * A `GraphClientError`, so the Graph SDK hands it on unchanged rather than as a `statusCode: -1`
 * `GraphError`.
 */
export class RequestNotSentError extends GraphClientError {
  constructor(cause: unknown) {
    super('The Graph request was not sent: its attempt had ended');
    // GraphClientError resets the prototype to its own, which would break `instanceof` here.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'RequestNotSentError';
    this.cause = cause;
  }
}

/**
 * Rethrows why an attempt ended before its request was sent, when `err` says it did: a run outage,
 * for instance, ends the call with the outage rather than with a failed request.
 */
export function rethrow_if_stopped_before_send(err: unknown): void {
  if (err instanceof RequestNotSentError) throw err.cause;
}
