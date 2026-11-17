/**
 * Request identity: what makes two requests "the same request" across attempts
 * and across runs. Pure; the per-run ordinals it consumes come from
 * identity-ordinals.mjs.
 *
 * The base identity is method + host + path + the stable part of the query.
 * Real ids stay in, because "message A" and "message B" are different requests
 * that may deserve different faults. Volatile parameters (the ones
 * `ELIDE_PARAMS` matches: delta and skip tokens, tempauth, SAS signatures) come
 * out, and the remaining parameters are sorted.
 *
 * Three refinements make the identity match what a person would call "the same
 * request", which replay, verdicts and compare all depend on:
 *   - upload fragments: the session URL is a credential that changes every
 *     session, so it is templated, and the session's ordinal (per templated
 *     shape, in order of first arrival) plus the Content-Range start offset
 *     distinguish "fragment N of file M";
 *   - paging: a request carrying a delta or skip token gets the ordinal of that
 *     cursor value among the cursors seen for its base identity, so page 3 of a
 *     listing differs from page 2 while a retried page keeps its ordinal;
 *   - small JSON bodies: the body's keyed digest, so two different `$batch`
 *     calls or two creates in one folder are different requests.
 *
 * The identity string holds raw ids and is never written anywhere; only its
 * keyed digest (identity-key-store.mjs) reaches the journal.
 */
import { ELIDE_PARAMS, template_path } from '../../../graph-tap/redact.mjs';

const UPLOAD_SESSION_PATH = /uploadsession|attachmentsessions/i;
const SESSION_PARAMS = /^guid$/i;

/** Decodes a query key for matching; undecodable keys are matched as written. */
function decode_key(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** Splits a path into the part before `?` and its query pairs. */
function split_query(raw_path) {
  const q = raw_path.indexOf('?');
  if (q === -1) return { path: raw_path, pairs: [] };
  return {
    path: raw_path.slice(0, q),
    pairs: raw_path
      .slice(q + 1)
      .split('&')
      .filter(Boolean),
  };
}

/** True for a PUT of an upload-session fragment on a pre-authenticated transfer host. */
export function is_upload_fragment(method, raw_path, is_transfer) {
  return (
    String(method).toUpperCase() === 'PUT' &&
    is_transfer &&
    UPLOAD_SESSION_PATH.test(split_query(raw_path).path)
  );
}

/** The base identity: method, host, path (session URLs templated) and the stable, sorted query. */
export function base_identity(method, origin, raw_path, is_transfer = false) {
  const { path, pairs } = split_query(raw_path);
  const upload_session = is_transfer && UPLOAD_SESSION_PATH.test(path);
  const kept = pairs
    .filter((pair) => {
      const key = decode_key(pair.split('=')[0]);
      return !ELIDE_PARAMS.test(key) && !(upload_session && SESSION_PARAMS.test(key));
    })
    .sort();
  const stable_path = upload_session ? template_path(path) : path;
  const query = kept.length ? `?${kept.join('&')}` : '';
  return `${String(method).toUpperCase()} ${String(origin).toLowerCase()}${stable_path}${query}`;
}

/** Appends the refinements (session, offset, page, body digest) that apply to a base identity. */
export function compose_identity(base, { session, offset, page, body_digest } = {}) {
  const parts = [base];
  if (session) parts.push(`session=${session}`);
  if (offset !== null && offset !== undefined) parts.push(`offset=${offset}`);
  if (page) parts.push(`page=${page}`);
  if (body_digest) parts.push(`body=${body_digest}`);
  return parts.join('\u0000');
}

/** The start offset of a Content-Range header (`bytes 0-327679/1048576` -> 0), or null. */
export function content_range_start(header) {
  const match = /^\s*bytes\s+(\d+)-/i.exec(String(header ?? ''));
  return match ? Number(match[1]) : null;
}

/** Finds the cursor a request carries: { type: 'delta' | 'skip', value } or null. */
export function find_cursor(raw_path, kind) {
  let skip = null;
  for (const pair of split_query(raw_path).pairs) {
    const eq = pair.indexOf('=');
    const key = decode_key(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    if (key === '$deltatoken' || key === 'deltatoken') return { type: 'delta', value };
    // Drive delta pages carry their cursor as a plain `token` parameter.
    if (kind === 'delta' && key === 'token') return { type: 'delta', value };
    if (key === '$skiptoken' || key === 'skiptoken') skip = { type: 'skip', value };
  }
  return skip;
}

/** Reports whether a request carries a delta token or a skip token: `delta`, `skip` or null. */
export function request_cursor(raw_path, kind) {
  return find_cursor(raw_path, kind)?.type ?? null;
}

/**
 * False for POST and for PATCH without If-Match; true otherwise. A token
 * request is a POST that changes nothing, so re-sending it is not a duplicate write.
 */
export function is_idempotent(method, has_if_match, kind) {
  if (kind === 'token') return true;
  const verb = String(method).toUpperCase();
  if (verb === 'POST') return false;
  if (verb === 'PATCH') return Boolean(has_if_match);
  return true;
}
