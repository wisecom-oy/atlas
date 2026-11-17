/**
 * The per-request stderr line, e.g.
 *   [outagesoft-365] throttle_429 429 GET graph.microsoft.com/v1.0/users/{upn}/messages 3ms
 * Built only from redacted fields, like the journal.
 */

/** Formats a finished exchange as one stderr line. */
export function format_exchange_line(ex) {
  const fault = ex.fault ? `${ex.fault.id}${ex.fault.skipped ? '(skipped)' : ''}` : 'ok';
  const { status, outcome, total_ms } = ex.delivered;
  let result;
  if (outcome === 'complete') result = String(status);
  else if (status) result = `${status}+${outcome}`;
  else result = outcome;
  return `[outagesoft-365] ${fault} ${result} ${ex.method} ${ex.url} ${total_ms}ms`;
}
