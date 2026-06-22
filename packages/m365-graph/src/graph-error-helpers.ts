import { logger } from '@atlas/core/utils/logger';

const RETRYABLE_STATUS_CODES = new Set([429, 503, 504]);
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const MAX_RETRIES = 12;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Detects Graph errors that indicate an invalid/expired delta token.
 * Matches Corso's pattern: syncStateNotFound, resyncRequired, syncStateInvalid.
 */
export function is_invalid_delta_error(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('syncstatenotfound') ||
    lower.includes('resyncrequired') ||
    lower.includes('syncstateinvalid')
  );
}

/**
 * Detects 403 ErrorAccessDenied from Graph and rethrows with
 * actionable guidance about which API permissions to grant.
 */
export function rethrow_if_access_denied(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode !== 403) return;

  const required = [
    'Mail.Read              -- read mailbox messages',
    'Mail.ReadWrite         -- delta sync and full message fetch',
    'User.Read.All          -- list tenant users / mailboxes',
    'MailboxSettings.Read   -- enumerate mail folders',
  ];

  const hint =
    `Microsoft Graph returned 403 Forbidden (ErrorAccessDenied).\n` +
    `The app registration needs these Application permissions with admin consent:\n\n` +
    required.map((p) => `  - ${p}`).join('\n') +
    `\n\n` +
    `Grant them in Azure Portal > App registrations > API permissions > ` +
    `Add a permission > Microsoft Graph > Application permissions, ` +
    `then click "Grant admin consent".`;

  throw new Error(hint);
}

/**
 * Detects MailboxNotEnabledForRESTAPI from Graph and rethrows with
 * actionable guidance about reassigning an Exchange Online license.
 */
export function rethrow_if_mailbox_not_licensed(err: unknown): void {
  const graph_err = err as Record<string, unknown>;
  const code = String(graph_err.code ?? '');
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'MailboxNotEnabledForRESTAPI' || message.includes('MailboxNotEnabledForRESTAPI')) {
    throw new Error(
      `The mailbox is not licensed for API access (MailboxNotEnabledForRESTAPI).\n` +
        `This typically happens when the user's Exchange Online license has been removed.\n` +
        `The mailbox data is retained for 30 days after license removal, but cannot be\n` +
        `accessed via the Graph API until a license is reassigned.\n\n` +
        `To back up or restore this mailbox:\n` +
        `  1. Reassign an Exchange Online license to the user in Microsoft 365 admin center\n` +
        `  2. Wait a few minutes for the mailbox to reconnect\n` +
        `  3. Run the operation again\n` +
        `  4. Remove the license after the operation completes (if desired)`,
    );
  }
}

/** Returns true when the error carries a transient HTTP status (429, 503, 504). */
export function is_transient_error(err: unknown): boolean {
  const status = (err as Record<string, unknown>).statusCode;
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Returns true for network-level errors (socket timeout, DNS failure,
 * connection reset) that are worth retrying.
 */
export function is_network_error(err: unknown): boolean {
  const code = (err as Record<string, unknown>).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes('socket hang up') ||
    lower.includes('network request failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('terminated') ||
    lower.includes('aborted') ||
    lower.includes('network error') ||
    lower.includes('client network socket disconnected')
  );
}

/** Returns true when an error is retryable (transient HTTP or network error). */
export function is_retryable_error(err: unknown): boolean {
  return is_transient_error(err) || is_network_error(err);
}

/**
 * Wraps any async network call with exponential backoff + jitter for both
 * transient HTTP errors (429, 503, 504) and network-level errors (ETIMEDOUT,
 * ECONNRESET, socket hang up, etc.).
 *
 * Retries up to 12 times with delays capped at 5 minutes, giving a total
 * retry budget of ~23 minutes to survive extended network outages.
 * Respects Retry-After on 429. Each retry is logged for observability.
 *
 * This function is designed to be reusable across backup, restore, save, and
 * any other operation that communicates over the network.
 */
export async function with_graph_retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await race_timeout(fn(), REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (!is_retryable_error(err) || attempt === MAX_RETRIES) throw err;

      const retry_after = extract_retry_after(err);
      const base = retry_after ?? BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.random() * BASE_DELAY_MS;
      const delay = Math.min(base + jitter, MAX_DELAY_MS);

      const reason = describe_error(err);
      logger.debug(
        `Retry ${attempt + 1}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );

      await sleep(delay);
    }
  }

  throw new Error('with_graph_retry: unreachable');
}

/** Extracts the Retry-After header value (in ms) from a Graph error, if present. */
function extract_retry_after(err: unknown): number | undefined {
  const graph_err = err as Record<string, unknown>;
  const headers_sources = [
    graph_err.headers as Record<string, string> | undefined,
    graph_err.responseHeaders as Record<string, string> | undefined,
    (graph_err.response as Record<string, unknown> | undefined)?.headers as
      | Record<string, string>
      | undefined,
  ];
  for (const headers of headers_sources) {
    if (!headers) continue;
    const value = headers['retry-after'] ?? headers['Retry-After'];
    if (!value) continue;
    const seconds = parseInt(value, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return undefined;
}

function describe_error(err: unknown): string {
  const graph_err = err as Record<string, unknown>;
  if (graph_err.statusCode) return `HTTP ${graph_err.statusCode}`;
  if (graph_err.code) return String(graph_err.code);
  return err instanceof Error ? err.message.slice(0, 80) : 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Races a promise against a timeout; rejects with ETIMEDOUT on expiry. */
function race_timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
