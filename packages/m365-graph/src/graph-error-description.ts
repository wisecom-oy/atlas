/**
 * Renders any Graph/network error as a non-empty, actionable one-liner.
 * Graph SDK errors routinely carry an empty `message` with the useful part in
 * `statusCode`/`code`/`body`, so every available facet is joined rather than
 * picking the first one present (issue #92).
 */
export function describe_graph_error(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err !== 'object') return String(err);

  const graph_err = err as Record<string, unknown>;
  const status = graph_err.statusCode ?? graph_err.status;
  const message = err instanceof Error ? err.message.trim() : '';
  const parts = [
    typeof status === 'number' || typeof status === 'string' ? `HTTP ${status}` : '',
    typeof graph_err.code === 'string' ? graph_err.code.trim() : '',
    message.slice(0, 200),
    message === '' && typeof graph_err.body === 'string' ? graph_err.body.slice(0, 200) : '',
  ].filter((part) => part !== '');

  return parts.length > 0 ? parts.join(' -- ') : `unknown error (${err.constructor.name})`;
}
