/**
 * The relay path prefix, shared by the preloads (which encode) and the relay
 * (which decodes).
 *
 * A re-routed request keeps its original path and gains two leading segments:
 * the per-run token and the original origin, URI-encoded so its `://` and port
 * survive as one segment. Encoding the origin into the path, rather than into a
 * header, means nothing about the request's headers changes on the way through,
 * so the relay forwards exactly what the client would have sent.
 *
 *   https://graph.microsoft.com/v1.0/me  ->  /<token>/https%3A%2F%2Fgraph.microsoft.com/v1.0/me
 */

/** Builds the relay path for a request to `origin` + `path`. */
export function encode_relay_path(token, origin, path) {
  const rest = path && path.startsWith('/') ? path : `/${path ?? ''}`;
  return `/${token}/${encodeURIComponent(origin)}${rest}`;
}

/**
 * Splits a relay path into token, origin and original path.
 *
 * Returns null for anything malformed. The origin must be a bare origin (no
 * path, credentials or query), so a crafted segment cannot smuggle a different
 * target past the host allowlist.
 */
export function decode_relay_path(relay_path) {
  if (typeof relay_path !== 'string' || !relay_path.startsWith('/')) return null;
  const token_end = relay_path.indexOf('/', 1);
  if (token_end === -1) return null;
  const origin_end = relay_path.indexOf('/', token_end + 1);
  const encoded_origin =
    origin_end === -1
      ? relay_path.slice(token_end + 1)
      : relay_path.slice(token_end + 1, origin_end);
  const path = origin_end === -1 ? '/' : relay_path.slice(origin_end);

  let origin;
  try {
    origin = decodeURIComponent(encoded_origin);
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { token: relay_path.slice(1, token_end), origin, path };
}
