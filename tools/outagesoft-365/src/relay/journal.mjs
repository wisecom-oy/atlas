/**
 * The run journal: one JSON line per relayed exchange, written when it ends.
 *
 * Entries are built field by field from an allowlist, never by spreading an
 * exchange object, so a header, a body or a raw URL cannot reach the file by
 * accident when the exchange grows a new field. URLs pass only through
 * graph-tap's `normalize_url` (tools/graph-tap/redact.mjs), which templates
 * ids, paths, sites, tenants and string literals and elides credentials.
 *
 * Writes are synchronous appends: each line is small, and a run killed with
 * SIGKILL still leaves every finished exchange on disk.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { normalize_url, template_host, template_path } from '../../../graph-tap/redact.mjs';
import { get_fault } from '../faults/fault-catalog.mjs';

/** Redacts a request URL for the journal and terminal; never throws. */
export function redact_request_url(origin, raw_path) {
  try {
    return normalize_url(origin, raw_path);
  } catch {
    // Defensive only: with no URL at all to show, the shape without its query is still useful.
    const host = origin.replace(/^https?:\/\//, '');
    return `${template_host(host)}${template_path(raw_path.split('?')[0], host)}?<unparsed query>`;
  }
}

/**
 * Keyed digest of the request body, null for GET, for identity requests, and
 * when no body bytes were read (including a reset before the relay read any).
 * A pre-read JSON body already has its key; a streamed one is finished here.
 */
function body_key(ex) {
  if (ex.body_key !== undefined) return ex.body_key;
  if (!ex.body_hmac || ex.req_bytes === 0) return null;
  return ex.body_hmac.digest('hex').slice(0, 16);
}

/** Builds the journal line for a finished exchange from an explicit field allowlist. */
export function build_journal_entry(ex) {
  const entry = {
    seq: ex.seq,
    t: ex.t,
    method: ex.method,
    url: ex.url,
    url_key: ex.url_key,
    identity_key: ex.identity_key,
    occurrence: ex.occurrence,
    base_key: ex.base_key,
    page: ex.page ?? null,
    service: ex.service,
    kind: ex.kind,
    cursor: ex.cursor,
    idempotent: ex.idempotent,
    req_bytes: ex.req_bytes,
    body_key: body_key(ex),
    fault: ex.fault
      ? {
          id: ex.fault.id,
          category: get_fault(ex.fault.id)?.category ?? null,
          source: ex.fault.source,
          params: ex.fault.params,
          ...(ex.fault.skipped ? { skipped: ex.fault.skipped } : {}),
          ...(ex.fault.forced ? { forced: true } : {}),
        }
      : null,
    forwarded: ex.forwarded,
    upstream: ex.upstream
      ? {
          status: ex.upstream.status ?? null,
          first_byte_ms: ex.upstream.first_byte_ms ?? null,
          total_ms: ex.upstream.total_ms ?? null,
          bytes: ex.upstream.bytes,
          ...(ex.upstream.error ? { error: ex.upstream.error } : {}),
        }
      : null,
    delivered: {
      status: ex.delivered.status ?? null,
      outcome: ex.delivered.outcome,
      bytes: ex.delivered.bytes,
      total_ms: ex.delivered.total_ms,
      ...(ex.delivered.retry_after_s !== undefined
        ? { retry_after_s: ex.delivered.retry_after_s }
        : {}),
      ...(ex.delivered.error ? { error: ex.delivered.error } : {}),
    },
  };
  if (ex.graph_error) entry.graph_error = ex.graph_error;
  if (ex.relay_error) entry.relay_error = ex.relay_error;
  return entry;
}

/** Opens an append-only JSONL journal; write failures are reported once and never thrown. */
export function open_journal(path) {
  const fd = openSync(path, 'a', 0o600);
  let closed = false;
  let warned = false;
  const append = (record) => {
    if (closed) return;
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } catch (error) {
      if (!warned)
        process.stderr.write(
          `[outagesoft-365] journal write failed: ${error.code ?? error.message}\n`,
        );
      warned = true;
    }
  };
  return {
    /** Appends one exchange entry. */
    write_entry: (entry) => append(entry),
    /** Appends a top-level relay_error line; the message must already be free of request data. */
    write_relay_error: (message) => append({ relay_error: message }),
    /** Closes the file; later writes are dropped. */
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
