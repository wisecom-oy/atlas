import { ClientSecretCredential, type ClientSecretCredentialOptions } from '@azure/identity';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  graph_json_response,
  held_graph_fetch,
  type HeldGraphFetch,
} from '@wisecom/atlas-types/testing/held-graph-fetch';
import { create_graph_client } from '@/graph-client.factory';
import { with_graph_retry } from '@/graph-request-error-handler';
import { TypedTokenAuthProvider } from '@/graph-token-auth-provider';
import { token_request_policies } from '@/graph-token-request-policies';

/**
 * Issues #875 and #889: `@azure/identity` takes no abort signal for a client-secret token request
 * and waits out Entra's `Retry-After` itself, so a token request outlived the attempt that needed
 * it, and every timed-out attempt added a token request of its own. These run the real credential,
 * with Atlas's pipeline policies, against a scripted Entra ID.
 */

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TIMEOUT_MS = 60_000;

type HttpClient = NonNullable<ClientSecretCredentialOptions['httpClient']>;
type PipelineRequest = Parameters<HttpClient['sendRequest']>[0];
type PipelineResponse = Awaited<ReturnType<HttpClient['sendRequest']>>;
type EntraAnswer = { status: number; body: Record<string, unknown>; retry_after?: string };

const ISSUED: EntraAnswer = {
  status: 200,
  body: { token_type: 'Bearer', expires_in: 3599, access_token: 'issued-token' },
};
const THROTTLED: EntraAnswer = {
  status: 429,
  body: { error: 'temporarily_unavailable', error_codes: [50196] },
  retry_after: '60',
};

/** A token request Entra ID received: when, and when Atlas closed it, if it did. */
interface TokenRequest {
  readonly sent_at: number;
  aborted_at: number | undefined;
}

function headers_of(answer: EntraAnswer): PipelineResponse['headers'] {
  const values = new Map([['content-type', 'application/json']]);
  if (answer.retry_after !== undefined) values.set('retry-after', answer.retry_after);
  return {
    get: (name: string) => values.get(name.toLowerCase()),
    has: (name: string) => values.has(name.toLowerCase()),
    set: (name: string, value: string | number) => void values.set(name.toLowerCase(), `${value}`),
    delete: (name: string) => void values.delete(name.toLowerCase()),
    toJSON: () => Object.fromEntries(values),
    [Symbol.iterator]: () => values.entries(),
  };
}

/**
 * Entra ID answering each token request with `answer_at(now)`, or holding it open without an
 * answer while that returns undefined. A held request closes only when its abort signal fires.
 */
function scripted_entra(answer_at: (now: number) => EntraAnswer | undefined) {
  const requests: TokenRequest[] = [];
  const client: HttpClient = {
    sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
      const record: TokenRequest = { sent_at: Date.now(), aborted_at: undefined };
      requests.push(record);
      const answer = answer_at(Date.now());
      if (answer !== undefined) {
        return Promise.resolve({
          request,
          status: answer.status,
          headers: headers_of(answer),
          bodyAsText: JSON.stringify(answer.body),
        });
      }
      return new Promise((_, reject) => {
        request.abortSignal?.addEventListener('abort', () => {
          record.aborted_at = Date.now();
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        });
      });
    },
  };
  const open_at = (time: number): number =>
    requests.filter((r) => r.sent_at <= time && (r.aborted_at ?? Infinity) > time).length;
  return { client, requests, open_at };
}

/** A Graph client whose token comes from the real credential, wired as Atlas wires it. */
function graph_client_for(entra: HttpClient) {
  const credential = new ClientSecretCredential(TENANT_ID, 'client-id', '<redacted>', {
    httpClient: entra,
    additionalPolicies: token_request_policies(),
  });
  const provider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return create_graph_client(new TypedTokenAuthProvider(() => provider));
}

let rig: HeldGraphFetch;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  rig = held_graph_fetch();
  vi.stubGlobal('fetch', rig.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a token request no attempt waits for any more (issues #875, #889)', () => {
  it('is closed when its attempt times out, so a silent endpoint never has two open', async () => {
    const entra = scripted_entra((now) => (now < 120_000 ? undefined : ISSUED));
    const client = graph_client_for(entra.client);
    const outcome = with_graph_retry(() => client.api('/users/u').get());

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(entra.requests[0]!.aborted_at).toBe(TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 5_000);
    const sent = entra.requests.map((request) => request.sent_at);
    expect(Math.max(...sent.map((at) => entra.open_at(at)))).toBe(1);
    expect(rig.requests).toHaveLength(1);

    rig.answer(0, graph_json_response({ id: 'u' }));
    await expect(outcome).resolves.toEqual({ id: 'u' });
  });

  it("names Entra's 429 when the attempt timed out waiting, and waits it out", async () => {
    const entra = scripted_entra((now) => (now < 90_000 ? THROTTLED : ISSUED));
    const client = graph_client_for(entra.client);
    const outcome = with_graph_retry(() => client.api('/users/u').get());

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(entra.requests).toHaveLength(1);
    expect(entra.requests[0]!.aborted_at).toBeUndefined();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.stringContaining('did not issue a Graph token before the attempt timed out'),
    );
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(expect.stringContaining('HTTP 429'));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(entra.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(entra.requests).toHaveLength(2);
    expect(rig.requests).toHaveLength(1);
    rig.answer(0, graph_json_response({ id: 'u' }));
    await expect(outcome).resolves.toEqual({ id: 'u' });
  });
});
