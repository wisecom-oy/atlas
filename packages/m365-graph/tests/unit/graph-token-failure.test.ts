import { ClientSecretCredential, type ClientSecretCredentialOptions } from '@azure/identity';
import { GraphClientError } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { describe, expect, it } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import { create_graph_client } from '@/graph-client.factory';
import { TypedTokenAuthProvider } from '@/graph-token-auth-provider';
import {
  GraphTokenRequestError,
  is_transient_token_request_error,
  token_request_refusal,
} from '@/graph-token-failure';

/**
 * Issue #786: a token request Entra ID refused reached Atlas as the Graph SDK's `statusCode: -1`
 * error, indistinguishable from a network failure, and exited 1. These run the real
 * `@azure/identity` credential and Graph client against canned Entra ID answers, so the error
 * shapes are the libraries' own rather than a guess at them.
 */

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

type HttpClient = NonNullable<ClientSecretCredentialOptions['httpClient']>;
type PipelineRequest = Parameters<HttpClient['sendRequest']>[0];
type PipelineResponse = Awaited<ReturnType<HttpClient['sendRequest']>>;
type EntraAnswer = { status: number; body: Record<string, unknown> } | { network: string };

/** Headers enough for the identity pipeline to read a JSON token-endpoint answer. */
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

/** An HTTP client that gives every token request the same answer, and counts them. */
function entra_answering(answer: EntraAnswer): HttpClient & { requests: number } {
  const client = {
    requests: 0,
    sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
      client.requests++;
      if ('network' in answer) {
        return Promise.reject(
          Object.assign(new Error(`connect ${answer.network}`), { code: answer.network }),
        );
      }
      return Promise.resolve({
        request,
        status: answer.status,
        headers: json_headers(),
        bodyAsText: JSON.stringify(answer.body),
      });
    },
  };
  return client;
}

function provider_for(answer: EntraAnswer): TypedTokenAuthProvider {
  const credential = new ClientSecretCredential(TENANT_ID, 'client-id', '<redacted>', {
    httpClient: entra_answering(answer),
    retryOptions: { maxRetries: 0 },
  });
  return new TypedTokenAuthProvider(
    new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    }),
  );
}

function entra_error(status: number, error: string, aadsts: string): EntraAnswer {
  return { status, body: { error, error_description: `${aadsts}: description` } };
}

describe('token request failures', () => {
  it.each([
    ['a wrong or expired client secret', entra_error(401, 'invalid_client', 'AADSTS7000215'), 401],
    ['an unknown client ID', entra_error(400, 'unauthorized_client', 'AADSTS700016'), 400],
    ['a tenant that does not exist', entra_error(400, 'invalid_request', 'AADSTS90002'), 400],
  ])('types %s as AuthError', async (_label, answer, status) => {
    const failure = await provider_for(answer)
      .getAccessToken()
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GraphTokenRequestError);
    expect(failure).toMatchObject({ entra_status: status, transient: false });
    const refusal = token_request_refusal(failure);
    expect(refusal).toBeInstanceOf(AuthError);
    expect(refusal?.code).toBe('ATLAS_AUTH_DENIED');
    expect(refusal?.message).toContain(`HTTP ${status}`);
  });

  it.each([
    ['an Entra ID outage', entra_error(503, 'temporarily_unavailable', 'AADSTS90033'), 503],
    ['Entra ID throttling', entra_error(429, 'temporarily_unavailable', 'AADSTS50196'), 429],
    ['a refused connection', { network: 'ECONNREFUSED' }, undefined],
  ])('marks %s transient, not refused', async (_label, answer, status) => {
    const failure = await provider_for(answer)
      .getAccessToken()
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GraphTokenRequestError);
    expect(failure).toMatchObject({ entra_status: status, transient: true });
    expect(is_transient_token_request_error(failure)).toBe(true);
    expect(token_request_refusal(failure)).toBeUndefined();
  });

  it('crosses the Graph SDK intact instead of becoming a statusCode -1 GraphError', async () => {
    const client = create_graph_client(
      provider_for(entra_error(401, 'invalid_client', 'AADSTS7000215')),
    );

    const failure = await client
      .api('/users')
      .get()
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GraphTokenRequestError);
    expect(failure).toBeInstanceOf(GraphClientError);
    expect(failure).not.toHaveProperty('statusCode');
    expect(token_request_refusal(failure)).toBeInstanceOf(AuthError);
  });
});
