import { ClientSecretCredential, type ClientSecretCredentialOptions } from '@azure/identity';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, GraphUnavailableError } from '@wisecom/atlas-types';
import { with_graph_retry } from '@/graph-request-error-handler';
import { TypedTokenAuthProvider } from '@/graph-token-auth-provider';
import {
  GraphTokenRequestError,
  MSAL_THROTTLE_WINDOW_MS,
  to_token_request_error,
  token_request_refusal,
} from '@/graph-token-failure';

/**
 * Issue #860: after Entra ID answers a token request with a 429 or 5xx, MSAL answers every repeat
 * inside its throttle window from its own cache, with a `ServerError` that has no `status` and a
 * numeric `errorCode`. Atlas read that replay as an unclassified failure, stopped retrying, and
 * exited 1. These run the real `@azure/identity` credential against scripted Entra ID answers, so
 * the replay is MSAL's own.
 */

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

type HttpClient = NonNullable<ClientSecretCredentialOptions['httpClient']>;
type PipelineRequest = Parameters<HttpClient['sendRequest']>[0];
type PipelineResponse = Awaited<ReturnType<HttpClient['sendRequest']>>;
type EntraAnswer = { status: number; body: Record<string, unknown> };

const OUTAGE: EntraAnswer = {
  status: 503,
  body: {
    error: 'temporarily_unavailable',
    error_description: 'AADSTS90033: A transient error has occurred.',
    error_codes: [90033],
  },
};
const REFUSAL: EntraAnswer = {
  status: 401,
  body: {
    error: 'invalid_client',
    error_description: 'AADSTS7000215: Invalid client secret provided.',
    error_codes: [7000215],
  },
};
const ISSUED: EntraAnswer = {
  status: 200,
  body: { token_type: 'Bearer', expires_in: 3599, access_token: 'issued-token' },
};

function json_headers(): PipelineResponse['headers'] {
  const values = new Map([['content-type', 'application/json']]);
  return {
    get: (name: string) => values.get(name.toLowerCase()),
    has: (name: string) => values.has(name.toLowerCase()),
    set: (name: string, value: string | number) => void values.set(name.toLowerCase(), `${value}`),
    delete: (name: string) => void values.delete(name.toLowerCase()),
    toJSON: () => Object.fromEntries(values),
    [Symbol.iterator]: () => values.entries(),
  };
}

/** Entra ID answering with `answer_at(n)` for the n-th token request it receives, timed. */
function scripted_entra(answer_at: (request: number) => EntraAnswer) {
  const sent_at: number[] = [];
  const client: HttpClient = {
    sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
      sent_at.push(Date.now());
      const answer = answer_at(sent_at.length);
      return Promise.resolve({
        request,
        status: answer.status,
        headers: json_headers(),
        bodyAsText: JSON.stringify(answer.body),
      });
    },
  };
  return { client, sent_at };
}

function provider_for(client: HttpClient): TypedTokenAuthProvider {
  const credential = new ClientSecretCredential(TENANT_ID, 'client-id', '<redacted>', {
    httpClient: client,
    retryOptions: { maxRetries: 0 },
  });
  const provider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return new TypedTokenAuthProvider(() => provider);
}

/** MSAL's throttle replay as `@azure/identity` wraps it: no `status`, numeric `errorCode`. */
function msal_throttle_replay(error_code: string): Error {
  const server_error = Object.assign(
    new Error(`${error_code}: AADSTS90033: A transient error has occurred.`),
    { name: 'ServerError', errorCode: error_code, errorMessage: 'AADSTS90033' },
  );
  return Object.assign(new Error(server_error.message, { cause: server_error }), {
    name: 'AuthenticationRequiredError',
  });
}

describe('MSAL throttle replay classification', () => {
  it.each([['90033'], ['90033 50196'], ['']])(
    'marks the replay with errorCode "%s" transient, waiting out the window',
    (error_code) => {
      const failure = to_token_request_error(msal_throttle_replay(error_code));

      expect(failure).toMatchObject({
        transient: true,
        entra_status: undefined,
        retry_after_ms: MSAL_THROTTLE_WINDOW_MS,
      });
      expect(token_request_refusal(failure)).toBeUndefined();
      expect(failure.message).not.toContain('no response');
      expect(failure.message).toContain('HTTP 429 or 5xx');
    },
  );

  it('does not read a ServerError that carries a status as a replay', () => {
    const answered = Object.assign(new Error('invalid_client'), {
      name: 'ServerError',
      errorCode: 'invalid_client',
      status: 401,
    });

    const failure = to_token_request_error(answered);

    expect(failure.transient).toBe(false);
    expect(token_request_refusal(failure)).toBeInstanceOf(AuthError);
  });

  it('is what MSAL throws for a repeat inside its window, without a request to Entra ID', async () => {
    const entra = scripted_entra(() => OUTAGE);
    const provider = provider_for(entra.client);

    const first = await provider.getAccessToken().catch((e: unknown) => e);
    const second = await provider.getAccessToken().catch((e: unknown) => e);

    expect(entra.sent_at).toHaveLength(1);
    expect(first).toMatchObject({ entra_status: 503, transient: true });
    expect(second).toBeInstanceOf(GraphTokenRequestError);
    expect(second).toMatchObject({ entra_status: undefined, transient: true });
    expect((second as Error).message).not.toContain('no response');
  });
});

describe('with_graph_retry through an Entra ID outage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps retrying and completes once Entra ID recovers within the budget', async () => {
    const recovers_after_ms = 5 * 60_000;
    const started = Date.now();
    const entra = scripted_entra(() =>
      Date.now() - started < recovers_after_ms ? OUTAGE : ISSUED,
    );
    const provider = provider_for(entra.client);

    const token = with_graph_retry(() => provider.getAccessToken());
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    await expect(token).resolves.toBe('issued-token');
    expect(entra.sent_at.length).toBeGreaterThan(1);
  });

  it('never sends token requests closer together than MSAL’s throttle window', async () => {
    const entra = scripted_entra(() => OUTAGE);
    const provider = provider_for(entra.client);

    const failure = with_graph_retry(() => provider.getAccessToken()).catch((e: unknown) => e);
    for (let i = 0; i < 13; i++) await vi.advanceTimersByTimeAsync(300_000);

    const gaps = entra.sent_at.slice(1).map((at, index) => at - entra.sent_at[index]!);
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MSAL_THROTTLE_WINDOW_MS);
    expect(await failure).toBeInstanceOf(GraphUnavailableError);
  });

  it('ends with GraphUnavailableError after the full budget when the outage outlasts it', async () => {
    const entra = scripted_entra(() => OUTAGE);
    const provider = provider_for(entra.client);
    const fn = vi.fn(() => provider.getAccessToken());

    const failure = with_graph_retry(fn).catch((e: unknown) => e);
    for (let i = 0; i < 13; i++) await vi.advanceTimersByTimeAsync(300_000);

    expect(await failure).toBeInstanceOf(GraphUnavailableError);
    expect(await failure).toMatchObject({ code: 'ATLAS_GRAPH_UNAVAILABLE', retries: 12 });
    expect(fn).toHaveBeenCalledTimes(13);
  });

  it('still refuses a wrong client secret at once, without a retry', async () => {
    const entra = scripted_entra(() => REFUSAL);
    const provider = provider_for(entra.client);

    const failure = await with_graph_retry(() => provider.getAccessToken()).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(AuthError);
    expect(failure).toMatchObject({ code: 'ATLAS_AUTH_DENIED' });
    expect(entra.sent_at).toHaveLength(1);
  });
});
