/** HTTP attempts one retry chain makes before it gives up: the first try plus 12 retries. */
export const ATTEMPTS_PER_RETRY_CHAIN = 13;

/** Simulated time, in ms, that spends a whole retry budget: 13 backoff waits at the 5-minute cap. */
export const RETRY_BUDGET_SPAN_MS = ATTEMPTS_PER_RETRY_CHAIN * 300_000;

/**
 * A Microsoft Graph that answers every request with a `503` and no `Retry-After`, the shape a
 * service incident takes, counting the requests it was sent. Pass `send` as the attempt function of
 * `with_graph_retry` inside a stubbed connector method, so the run's retry loop meets the outage.
 */
export class GraphOutageFault {
  requests = 0;

  readonly send = async (): Promise<never> => {
    this.requests++;
    throw Object.assign(new Error('Service Unavailable'), {
      statusCode: 503,
      code: 'ServiceUnavailable',
    });
  };
}
