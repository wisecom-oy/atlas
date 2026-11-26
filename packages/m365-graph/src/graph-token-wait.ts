import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphClientError } from '@microsoft/microsoft-graph-client';
import { race_abort } from '@/graph-attempt-cancellation';
import type { GraphAttempt } from '@/graph-attempt';
import { to_token_wait_timeout_error, type EntraAnswer } from '@/graph-token-failure';

/**
 * One Graph token request, shared by every Graph request that needs a token while it runs.
 *
 * Without sharing, each attempt that timed out while Entra ID was slow left its own token request
 * running, and the next attempt started another one beside it (issue #889). With it, a credential
 * has at most one token request in progress. Each attempt waits for it under its own signals: an
 * attempt that times out or is cancelled stops waiting at once and sends nothing, and when no
 * attempt is waiting any more, the request itself is aborted, so it holds no socket open after
 * the run has finished with it (issue #875).
 */
const _token_request = new AsyncLocalStorage<SharedTokenRequest>();

export class SharedTokenRequest {
  readonly token: Promise<string>;
  private readonly controller = new AbortController();
  private waiters = 0;
  private settled = false;
  private last_answer: EntraAnswer | undefined;

  /** Starts `request` at once, inside this request's async context. */
  constructor(request: () => Promise<string>) {
    this.token = _token_request.run(this, request);
    const settle = (): void => {
      this.settled = true;
    };
    this.token.then(settle, settle);
  }

  /** Fires once every waiter has left before the token arrived. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether a new caller may wait for this request: it is neither finished nor abandoned. */
  is_joinable(): boolean {
    return !this.settled && !this.controller.signal.aborted;
  }

  /** Records an Entra ID answer other than success, to explain a timeout while waiting. */
  record_answer(answer: EntraAnswer): void {
    this.last_answer = answer;
  }

  /**
   * Waits for the token on behalf of `attempt`. Rejects with `AbandonedTokenWaitError` as soon as
   * the attempt may send nothing more, and marks the attempt as waiting for its token so its
   * timeout names the token request rather than `ETIMEDOUT`.
   */
  async wait(attempt: GraphAttempt | undefined): Promise<string> {
    this.waiters++;
    const end_token_wait = attempt?.begin_token_wait(() =>
      to_token_wait_timeout_error(this.last_answer),
    );
    try {
      return await race_abort(this.token, attempt?.send_signal);
    } catch (err) {
      if (attempt?.send_signal.aborted === true) throw new AbandonedTokenWaitError(err);
      throw err;
    } finally {
      end_token_wait?.();
      this.leave();
    }
  }

  /** Counts a waiter out, and aborts the request once nobody waits for it. */
  private leave(): void {
    this.waiters--;
    if (this.waiters > 0 || this.settled) return;
    this.controller.abort(new Error('No Graph request waits for this token any more'));
  }
}

/** The shared token request the current async context runs inside, if any. */
export function get_active_token_request(): SharedTokenRequest | undefined {
  return _token_request.getStore();
}

/**
 * A Graph request that stopped waiting for its token because its attempt may send nothing more:
 * it timed out, the run was cancelled, or the run met an outage. `cause` is why. Nothing was sent.
 *
 * A `GraphClientError`, so the Graph SDK hands it on unchanged rather than as a `statusCode: -1`
 * `GraphError`.
 */
export class AbandonedTokenWaitError extends GraphClientError {
  constructor(cause: unknown) {
    super('The Graph request stopped waiting for its token and was not sent');
    // GraphClientError resets the prototype to its own, which would break `instanceof` here.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'AbandonedTokenWaitError';
    this.cause = cause;
  }
}

/**
 * Rethrows why an attempt stopped before its request was sent, when `err` says it did: a run
 * outage, for instance, ends the call with the outage rather than with a failed request.
 */
export function rethrow_if_stopped_before_send(err: unknown): void {
  if (err instanceof AbandonedTokenWaitError) throw err.cause;
}
