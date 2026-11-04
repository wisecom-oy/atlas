/**
 * Graph-style paging: `$top`, `$skiptoken`, `@odata.nextLink`, and `$deltatoken`.
 *
 * Tokens are base64url JSON. Delta tokens carry the version range so the server answers a
 * stored link with exactly the changes since that snapshot, no matter how many pages it takes.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** @param {object} value */
export function encode_token(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** @param {string|null|undefined} raw */
export function decode_token(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Graph error carried to the server, which renders it as `{error: {code, message}}`. */
export class GraphHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   */
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Reads `$top`, clamped to Graph's 1 to 1000 range. */
export function read_top(query, fallback = 100) {
  const n = Number(query.get('$top'));
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.floor(n)) : fallback;
}

/**
 * Builds an absolute nextLink for the same resource path with a new skiptoken.
 * @param {string[]} segments decoded path segments below /v1.0
 * @param {URLSearchParams} query
 * @param {object} token next page state
 */
export function next_link(segments, query, token) {
  const params = new URLSearchParams(query);
  params.set('$skiptoken', encode_token(token));
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  return `${GRAPH_BASE}/${path}?${params.toString()}`;
}

/**
 * Serves one page of a plain collection.
 * @template T
 * @param {{items: T[], segments: string[], query: URLSearchParams, serialize: (item: T) => object}} args
 */
export function page_collection({ items, segments, query, serialize }) {
  const top = read_top(query);
  const token = decode_token(query.get('$skiptoken'));
  const offset = Number(token.o) || 0;
  const body = { value: items.slice(offset, offset + top).map(serialize) };
  if (offset + top < items.length) {
    body['@odata.nextLink'] = next_link(segments, query, { ...token, o: offset + top });
  }
  return { status: 200, json: body };
}
