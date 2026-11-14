/**
 * Everything the relay knows about a request before deciding its fault:
 * where it goes, what it is, and its keyed identity. Raw values (origin, path,
 * session URLs, cursor values) stay in memory for forwarding and ordinals;
 * only redacted or keyed forms are journaled.
 *
 * Identity is assigned in two steps because small JSON bodies are part of it:
 * `describe_request` runs on arrival, `assign_identity` once the body (if it
 * is pre-read) has been digested.
 */
import { createHmac } from 'node:crypto';
import { is_json_content_type } from './body-encoding.mjs';
import { keyed_digest } from './identity-key-store.mjs';
import { redact_request_url } from './journal.mjs';
import { classify_kind, classify_service } from './m365-hosts.mjs';
import {
  base_identity,
  compose_identity,
  content_range_start,
  find_cursor,
  is_idempotent,
  is_upload_fragment,
} from './request-identity.mjs';

/** Largest JSON body read before planning so it can join the identity. */
export const PREREAD_BODY_CAP_BYTES = 1024 * 1024;

const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT']);

/** Builds the facts known on arrival; session and page ordinals are assigned here, in arrival order. */
export function describe_request({ route, req, identity_secret, ordinals, seq, t }) {
  const { origin, path } = route;
  const hostname = new URL(origin).hostname;
  const method = String(req.method).toUpperCase();
  const service = classify_service(hostname, path);
  const kind = classify_kind(service, method, path);
  const is_transfer = service === 'transfer';
  const base = base_identity(method, origin, path, is_transfer);
  const fragment = is_upload_fragment(method, path, is_transfer);
  const cursor = find_cursor(path, kind);
  return {
    seq,
    t,
    method,
    origin,
    path,
    url: redact_request_url(origin, path),
    url_key: keyed_digest(identity_secret, `${method} ${origin}${path}`),
    // The identity before page, session, offset and body refinements: every page of one
    // listing shares it, so a restart of an enumeration can be told from a retried page.
    base_key: keyed_digest(identity_secret, base),
    service,
    kind,
    cursor: cursor?.type ?? null,
    page: cursor ? ordinals.page_ordinal(base, cursor.value) : null,
    idempotent: is_idempotent(method, req.headers['if-match'] !== undefined, kind),
    upload_fragment: fragment,
    identity_parts: {
      base,
      session: fragment ? ordinals.session_ordinal(base, `${origin}${path}`) : null,
      offset: fragment ? content_range_start(req.headers['content-range']) : null,
    },
    // Fed chunk by chunk as the body streams past (exchange.count_request_chunk). Never
    // for identity: that body holds the client secret, and even a keyed digest of a
    // secret is better not written down. Only 16 hex chars are ever journaled.
    body_hmac:
      method === 'GET' || service === 'identity' ? null : createHmac('sha256', identity_secret),
  };
}

/**
 * True when the body is read before planning: a JSON POST/PATCH/PUT with a
 * content-length of at most 1 MiB that is neither an upload fragment nor an
 * identity request. Larger and chunked bodies keep streaming and a URL-only identity.
 */
export function should_preread_body(ex) {
  if (!BODY_METHODS.has(ex.method) || ex.upload_fragment || ex.service === 'identity') return false;
  const length = ex.req.headers['content-length'];
  if (length === undefined || !/^\d+$/.test(length) || Number(length) > PREREAD_BODY_CAP_BYTES)
    return false;
  return is_json_content_type(ex.req.headers['content-type']);
}

/** Composes the identity (with the body digest when pre-read) and counts its occurrence. */
export function assign_identity(ex, identity_secret, ordinals) {
  const identity = compose_identity(ex.identity_parts.base, {
    ...ex.identity_parts,
    page: ex.page,
    body_digest: ex.body_key ?? null,
  });
  ex.identity_key = keyed_digest(identity_secret, identity);
  ex.occurrence = ordinals.next_occurrence(ex.identity_key);
}
