/**
 * Recognises a successful Graph answer whose JSON body could not be parsed (issue #868).
 *
 * The Graph SDK parses a JSON body with `response.json()`. When the body is empty, or ends early
 * on a clean close, that throws a `SyntaxError`, and the SDK wraps it as a `GraphError` that keeps
 * the response status (`200`) and copies the native error's name into `code`. The request was
 * answered, so this is not a transport failure, but the answer is unusable and a repeated GET
 * normally reads it whole. A body that stops arriving mid-stream fails as `terminated` instead and
 * is a network error (`graph-network-error.ts`).
 *
 * Only a 2xx qualifies. An error status whose body did not parse keeps its own classification by
 * status: a `404` with an empty body is still a `404`.
 */

/** The `code` the Graph SDK gives a wrapped `JSON.parse` failure: the native error's name. */
const SDK_WRAPPED_PARSE_FAILURE_CODE = 'SyntaxError';

/** True for a 2xx Graph answer whose body the SDK could not parse as JSON. */
export function is_unreadable_success_body(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { statusCode: status, code } = err as Record<string, unknown>;
  return (
    typeof status === 'number' &&
    status >= 200 &&
    status <= 299 &&
    code === SDK_WRAPPED_PARSE_FAILURE_CODE
  );
}
