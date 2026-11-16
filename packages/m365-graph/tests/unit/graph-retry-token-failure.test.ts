import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, GraphUnavailableError } from '@wisecom/atlas-types';
import { is_retryable_error, with_graph_retry } from '@/graph-request-error-handler';
import { GraphTokenRequestError, to_token_request_error } from '@/graph-token-failure';

/**
 * Issue #786: how the retry loop treats a failed token request. A refusal is the credentials'
 * fault and surfaces as `AuthError` at once; anything transient is retried like a Graph outage.
 */

/** The shape MSAL gives an Entra ID error answer, under identity's wrapper. */
function entra_answer(status: number, error_code: string): Error {
  const server_error = Object.assign(new Error(`${error_code}: description`), {
    name: 'ServerError',
    errorCode: error_code,
    status,
  });
  return Object.assign(new Error(server_error.message, { cause: server_error }), {
    name: 'AuthenticationRequiredError',
  });
}

/** The shape MSAL gives a token request that got no response. */
function no_entra_answer(): Error {
  const client_error = Object.assign(new Error('network_error: details'), {
    name: 'ClientAuthError',
    errorCode: 'network_error',
  });
  return Object.assign(new Error(client_error.message, { cause: client_error }), {
    name: 'AuthenticationRequiredError',
  });
}

async function exhaust(promise: Promise<unknown>): Promise<unknown> {
  const settled = promise.catch((e: unknown) => e);
  for (let i = 0; i < 13; i++) {
    await vi.advanceTimersByTimeAsync(300_000);
  }
  return await settled;
}

describe('with_graph_retry, failed token requests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws the AuthError a refused token request carries, without retrying', async () => {
    const carrier = to_token_request_error(entra_answer(401, 'invalid_client'));
    const fn = vi.fn().mockRejectedValue(carrier);

    const failure = await with_graph_retry(fn).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthError);
    expect(failure).toMatchObject({
      code: 'ATLAS_AUTH_DENIED',
      cause: entra_answer_cause(carrier),
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(is_retryable_error(carrier)).toBe(false);
  });

  it.each([
    ['no response', no_entra_answer()],
    ['an Entra ID 503', entra_answer(503, 'temporarily_unavailable')],
  ])('retries %s and gives up with GraphUnavailableError', async (_label, cause) => {
    const carrier = to_token_request_error(cause);
    const fn = vi.fn().mockRejectedValue(carrier);

    const failure = await exhaust(with_graph_retry(fn));

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(failure).toMatchObject({
      code: 'ATLAS_GRAPH_UNAVAILABLE',
      status_code: undefined,
      retries: 12,
      cause: carrier,
    });
    expect((failure as Error).message).toContain('Microsoft Entra ID did not issue a Graph token');
    expect(fn).toHaveBeenCalledTimes(13);
  });

  it('retries a transient token failure for a write that is not idempotent', async () => {
    const carrier = to_token_request_error(no_entra_answer());
    const fn = vi.fn().mockRejectedValueOnce(carrier).mockResolvedValue('created');

    const result = with_graph_retry(fn, { idempotent: false });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toBe('created');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a token failure it cannot classify', async () => {
    const carrier = to_token_request_error(new Error('unexpected'));
    const fn = vi.fn().mockRejectedValue(carrier);

    const failure = await with_graph_retry(fn).catch((e: unknown) => e);

    expect(failure).toBe(carrier);
    expect(failure).toBeInstanceOf(GraphTokenRequestError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

/** The credential error a refusal's AuthError keeps as its cause. */
function entra_answer_cause(carrier: GraphTokenRequestError): unknown {
  return (carrier.cause as Error).cause;
}
