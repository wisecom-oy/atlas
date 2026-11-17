import { GraphError, ResponseType, type GraphRequest } from '@microsoft/microsoft-graph-client';

/**
 * Binary Graph downloads (`$value`, `/content`) that keep the response headers on failure.
 *
 * The SDK converts a binary response by its type before it checks the status, then throws the
 * converted body. Its error handler copies the response headers only for a JSON Graph error or an
 * `Error`, so a 429 on an `ArrayBuffer` or stream request reached `with_graph_retry` with no
 * `Retry-After`: the retry fell back to exponential backoff from 1 s and the default 30 s
 * cooldown (issue #674). These helpers request the raw response instead and build the GraphError
 * themselves, with the status, the Graph error code and the headers, so Retry-After, 403
 * classification and 404 handling see the same shape a JSON request produces.
 */

/** The `error` object of a Graph error body, as far as the fields this module reads. */
interface GraphErrorDetail {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly innerError?: { readonly 'request-id'?: unknown };
}

/**
 * Sends a GET for the raw response and returns it when the status is 2xx. Any other status is
 * thrown as a GraphError carrying status, code and headers. The body is left unread.
 */
export async function get_graph_binary_response(request: GraphRequest): Promise<Response> {
  const response = (await request.responseType(ResponseType.RAW).get()) as Response;
  if (!response.ok) throw await graph_error_from_response(response);
  return response;
}

/** Downloads a binary Graph resource into memory. */
export async function get_graph_bytes(request: GraphRequest): Promise<ArrayBuffer> {
  const response = await get_graph_binary_response(request);
  return await response.arrayBuffer();
}

/**
 * Opens a binary Graph resource as the response body stream, unbuffered: the same stream
 * `getStream()` returns. A body-less 2xx (204) yields an empty stream.
 */
export async function get_graph_content_stream(
  request: GraphRequest,
): Promise<ReadableStream<Uint8Array>> {
  const response = await get_graph_binary_response(request);
  return response.body ?? empty_stream();
}

/**
 * Builds the GraphError the SDK builds for a JSON request: the status, Graph's error code and
 * message when the body is a Graph error, the request id, the body, and the response headers.
 * Reads the body, which on an error response is a few hundred bytes of JSON at most.
 */
export async function graph_error_from_response(response: Response): Promise<GraphError> {
  const text = await response.text().catch(() => '');
  const detail = parse_graph_error_detail(text);
  const error = new GraphError(response.status, string_or_undefined(detail?.message) ?? '');
  error.code = string_or_undefined(detail?.code) ?? null;
  error.requestId = string_or_undefined(detail?.innerError?.['request-id']) ?? null;
  error.body = detail === undefined ? text : JSON.stringify(detail);
  error.headers = response.headers;
  return error;
}

/** The `error` object of a Graph JSON error body, or undefined when the body is not one. */
function parse_graph_error_detail(text: string): GraphErrorDetail | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return undefined;
    const detail = parsed.error;
    return typeof detail === 'object' && detail !== null ? detail : undefined;
  } catch {
    return undefined;
  }
}

function string_or_undefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function empty_stream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.close();
    },
  });
}
