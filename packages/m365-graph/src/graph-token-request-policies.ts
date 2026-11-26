import type { ClientSecretCredentialOptions } from '@azure/identity';
import { parse_retry_after_ms } from '@/graph-retry-after';
import { get_active_token_request } from '@/graph-token-wait';

type AdditionalPolicy = NonNullable<ClientSecretCredentialOptions['additionalPolicies']>[number];
type PipelinePolicy = AdditionalPolicy['policy'];
type PipelineRequest = Parameters<PipelinePolicy['sendRequest']>[0];

/**
 * Pipeline policies for the credential's token requests to Microsoft Entra ID.
 *
 * `@azure/identity` takes no abort signal from a client-secret token request, and it waits out an
 * Entra `Retry-After` itself, so nothing stopped a token request once Atlas no longer needed it
 * (issues #875, #889). The first policy runs once per token request, ahead of the credential's
 * own retry policy: it ties the request, and every wait between its retries, to the shared token
 * request it serves, which is aborted when no Graph request waits for it any more. The second runs
 * on every try and records each answer other than success, so an attempt that times out while
 * waiting can name Entra's last answer.
 */
export function token_request_policies(): AdditionalPolicy[] {
  return [
    { policy: ABORT_WITH_SHARED_REQUEST, position: 'perCall' },
    { policy: RECORD_ENTRA_ANSWER, position: 'perRetry' },
  ];
}

const ABORT_WITH_SHARED_REQUEST: PipelinePolicy = {
  name: 'atlasTokenRequestAbort',
  sendRequest(request, next) {
    const shared = get_active_token_request();
    if (shared !== undefined) request.abortSignal = with_abort(request, shared.signal);
    return next(request);
  },
};

const RECORD_ENTRA_ANSWER: PipelinePolicy = {
  name: 'atlasTokenAnswerRecorder',
  async sendRequest(request, next) {
    const response = await next(request);
    if (response.status >= 400) {
      get_active_token_request()?.record_answer({
        status: response.status,
        retry_after_ms: parse_retry_after_ms(response.headers.get('retry-after')),
      });
    }
    return response;
  },
};

/** The request's own signal joined with `signal`, or `signal` alone when it has none. */
function with_abort(request: PipelineRequest, signal: AbortSignal): AbortSignal {
  const own = request.abortSignal;
  return own instanceof AbortSignal ? AbortSignal.any([own, signal]) : signal;
}
