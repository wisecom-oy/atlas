/**
 * Parses and validates one journal line into a flat attempt record.
 *
 * The journal is untrusted input: the relay may have crashed mid-line, a newer engine may add
 * fields, and a hand-edited file may hold anything. Every value the report later prints passes
 * through here, so strings are length-capped and stripped of control characters, numbers must be
 * finite, and a line that cannot be understood is classified with a reason instead of throwing.
 */

const MAX_LINE_CHARS = 1_000_000;
const FAULT_SOURCES = new Set(['profile', 'outage', 'replay']);
const CURSORS = new Set(['delta', 'skip']);
const KNOWN_OUTCOMES = new Set([
  'complete',
  'reset',
  'truncated',
  'no_response',
  'client_closed',
  'relay_error',
]);

/** Strips control characters and caps length, so untrusted text cannot break a table or a terminal. */
export function clean_text(value, max_chars = 200) {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (!stripped) return null;
  return stripped.length > max_chars ? `${stripped.slice(0, max_chars)}…` : stripped;
}

/** Fault ids are identifiers; anything else is replaced so it cannot smuggle text into the report. */
export function clean_identifier(value) {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'unrecognised_id';
}

/** A finite non-negative number, or the fallback. */
export function clean_number(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clean_status(value) {
  const n = clean_number(value);
  return n !== null && Number.isInteger(n) && n >= 100 && n <= 999 ? n : null;
}

function clean_outcome(value) {
  if (KNOWN_OUTCOMES.has(value)) return value;
  // An outcome this reader does not know is kept visible, and as it is not `complete` the
  // attempt counts as a failure rather than silently as a success.
  return clean_identifier(value) ?? 'unknown';
}

function read_skip_reason(skipped) {
  if (skipped === undefined || skipped === null || skipped === false) return null;
  return clean_text(String(skipped), 120) ?? 'unspecified';
}

// Fault params are deliberately not read: `retry_after_s` in them can describe something the
// client never received (batch_inner_429 puts it in sub-responses of an outer 200), so every
// Retry-After figure rests on `delivered.retry_after_s` alone.
function read_fault(fault) {
  if (!fault || typeof fault !== 'object') return null;
  return {
    fault_id: clean_identifier(fault.id) ?? 'unrecognised_id',
    fault_source: FAULT_SOURCES.has(fault.source) ? fault.source : 'profile',
    fault_skipped: read_skip_reason(fault.skipped),
    fault_category: clean_identifier(fault.category),
  };
}

const NO_FAULT = {
  fault_id: null,
  fault_source: null,
  fault_skipped: null,
  fault_category: null,
};

/** 16 hex digest of the request body, null when the request carried none, undefined when not recorded. */
function read_body_key(rec) {
  if (!('body_key' in rec)) return undefined;
  return typeof rec.body_key === 'string' && /^[0-9a-f]{1,64}$/.test(rec.body_key)
    ? rec.body_key
    : null;
}

/**
 * Keys that group repeated sends of the same request. A body digest separates two different
 * POSTs to one URL (two $batch calls) and keeps a re-send of the same write together.
 */
function grouping_keys(url_key, identity_key, body_key) {
  const suffix = body_key ? `#${body_key}` : '';
  return {
    retry_key: `${url_key}${suffix}`,
    identity_group: `${identity_key ?? url_key}${suffix}`,
  };
}

function read_upstream(upstream) {
  if (!upstream || typeof upstream !== 'object') {
    return { upstream_status: null, upstream_error: null };
  }
  return {
    upstream_status: clean_status(upstream.status),
    upstream_error: clean_text(upstream.error, 60),
  };
}

/** `delta`, `skip`, null when recorded as no cursor, undefined when the journal predates the field. */
function read_cursor(rec) {
  if (!('cursor' in rec)) return undefined;
  return CURSORS.has(rec.cursor) ? rec.cursor : null;
}

function read_page(rec) {
  if (!('page' in rec)) return undefined;
  return Number.isInteger(rec.page) && rec.page >= 0 ? rec.page : null;
}

function find_missing_field(rec) {
  if (clean_number(rec.t) === null) return 't';
  if (!clean_text(rec.method, 16)) return 'method';
  if (!clean_text(rec.url, 600)) return 'url';
  if (!rec.delivered || typeof rec.delivered !== 'object') return 'delivered';
  return null;
}

/** Converts a validated journal object into the flat attempt record the analysis works on. */
export function normalise_attempt(rec) {
  const method = clean_text(rec.method, 16).toUpperCase();
  // A literal backtick is never valid in a URL; encoding it keeps code spans and fenced blocks intact.
  const url = clean_text(rec.url, 600).replaceAll('`', '%60');
  const delivered = rec.delivered;
  const has_key = typeof rec.url_key === 'string' && rec.url_key.length > 0;
  const url_key = has_key ? clean_text(rec.url_key, 64) : `shape:${method} ${url}`;
  const identity_key =
    typeof rec.identity_key === 'string' ? clean_text(rec.identity_key, 64) : null;
  const body_key = read_body_key(rec);
  return {
    seq: clean_number(rec.seq, 0),
    t: rec.t,
    method,
    url,
    shape_key: `${method} ${url}`,
    // Without a key, attempts are grouped by template, which merges distinct ids; the reader
    // counts these so the report can say its retry inference is coarser.
    url_key,
    has_url_key: has_key,
    // Addendum A fields. Older journals lack them, so each has an explicit "unknown" value
    // (null or undefined) that the verdicts read as missing evidence rather than as false.
    identity_key,
    body_key,
    // Identity before the engine added page, fragment and body refinements; groups one listing.
    base_key: typeof rec.base_key === 'string' ? clean_text(rec.base_key, 64) : null,
    // Ordinal of the page within its listing; null when not paged, undefined in older journals.
    page: read_page(rec),
    ...grouping_keys(url_key, identity_key, body_key),
    occurrence: Number.isInteger(rec.occurrence) && rec.occurrence > 0 ? rec.occurrence : null,
    cursor: read_cursor(rec),
    idempotent: typeof rec.idempotent === 'boolean' ? rec.idempotent : null,
    service: clean_identifier(rec.service) ?? 'unknown',
    kind: clean_identifier(rec.kind) ?? 'unknown',
    req_bytes: clean_number(rec.req_bytes, 0),
    forwarded: rec.forwarded === true,
    ...(read_fault(rec.fault) ?? NO_FAULT),
    ...read_upstream(rec.upstream),
    status: clean_status(delivered.status),
    outcome: clean_outcome(delivered.outcome),
    bytes: clean_number(delivered.bytes, 0),
    total_ms: clean_number(delivered.total_ms, 0),
    retry_after_s: clean_number(delivered.retry_after_s),
    error: clean_text(delivered.error, 120),
    graph_error: clean_text(rec.graph_error, 80),
  };
}

/**
 * Classifies one raw journal line.
 * Returns `{ kind: 'attempt', attempt }`, `{ kind: 'relay_error', message }`,
 * `{ kind: 'malformed', reason }` or `{ kind: 'blank' }`.
 */
export function parse_journal_line(line) {
  if (!line.trim()) return { kind: 'blank' };
  if (line.length > MAX_LINE_CHARS) return { kind: 'malformed', reason: 'line too long' };
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return { kind: 'malformed', reason: 'not JSON' };
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { kind: 'malformed', reason: 'not an object' };
  }
  if ('relay_error' in rec && !('method' in rec)) {
    return {
      kind: 'relay_error',
      message: clean_text(String(rec.relay_error), 160) ?? 'unspecified',
    };
  }
  const missing = find_missing_field(rec);
  if (missing) return { kind: 'malformed', reason: `missing or invalid ${missing}` };
  return { kind: 'attempt', attempt: normalise_attempt(rec) };
}
