import { logger } from '@wisecom/atlas-core/utils/logger';
import { get_active_fence } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { parse_retry_after_ms } from '@/graph-retry-after';

/**
 * Statuses Graph recovers from on its own, per Microsoft's throttling and
 * resilience guidance: the request never reached a working backend, or the
 * gateway gave up on one. 501 and every 4xx stay out -- repeating those
 * returns the same answer.
 *
 * ponytail: one set for reads and writes. A 500 on a create POST can retry a
 * request the backend already committed, which restore surfaces as a duplicate
 * item -- the same exposure 504 already carried. Thread an idempotency flag
 * through GraphRetryOptions and opt the restore writers out if duplicates ever
 * show up in practice.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
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
/** Cooldown applied to a 429 that arrives without a usable Retry-After. */
const DEFAULT_THROTTLE_SECONDS = 30;

export interface GraphRetryOptions {
  /**
   * Per-attempt timeout. The default 60s bounds a single Graph request --
   * NEVER wrap a multi-page enumeration in one with_graph_retry call: the
   * timeout races the whole loop, restarts it from page 1 on expiry, and the
   * losing arm keeps consuming Graph quota (issue #33). Retry per page so the
   * paginator resumes from @odata.nextLink. Large single-object transfers
   * (attachment $value, file content) should pass a bigger window -- corso
   * converged on 1h default / 48h for large files against production tenants.
   */
  readonly timeout_ms?: number;
}

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

/** Returns true when the error carries a transient HTTP status (429, 500, 502, 503, 504). */
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
 * transient HTTP errors (429, 500, 502, 503, 504) and network-level errors (ETIMEDOUT,
 * ECONNRESET, socket hang up, etc.).
 *
 * Retries up to 12 times with delays capped at 5 minutes, giving a total
 * retry budget of ~23 minutes to survive extended network outages.
 * Respects Retry-After on 429. Each retry is logged for observability.
 *
 * This function is designed to be reusable across backup, restore, save, and
 * any other operation that communicates over the network.
 */
export async function with_graph_retry<T>(
  fn: () => Promise<T>,
  options: GraphRetryOptions = {},
): Promise<T> {
  const timeout_ms = options.timeout_ms ?? REQUEST_TIMEOUT_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Per attempt, not per call. A retry loop that started before the fence
    // went up would otherwise keep firing into Graph for the whole cooldown.
    await get_active_fence()?.wait();
    try {
      return await race_timeout(fn(), timeout_ms);
    } catch (err) {
      if (!is_retryable_error(err) || attempt === MAX_RETRIES) throw err;

      const retry_after = extract_retry_after(err);
      // Raise on the response that carried the 429, not after the budget is
      // spent, so every other owner backs off during this cooldown too.
      raise_fence_on_throttle(err, retry_after);
      const base = retry_after ?? BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.random() * BASE_DELAY_MS;
      const delay = Math.min(base + jitter, MAX_DELAY_MS);

      const reason = describe_graph_error(err);
      logger.debug(
        `Retry ${attempt + 1}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s -- ${reason}`,
      );

      await sleep(delay);
    }
  }
  throw new Error('with_graph_retry: unreachable');
}

/**
 * Raises the ambient throttle fence when `err` is a 429, so the cooldown starts
 * on the first throttled response rather than after a retry budget is spent.
 *
 * Only 429 raises the fence. A 500 or a socket reset is one unlucky request and
 * is the retry loop's business alone; a 429 is Graph asking the whole client to
 * slow down. `raise` is non-additive, so concurrent owners hitting the same
 * cooldown extend it rather than stacking it.
 */
function raise_fence_on_throttle(err: unknown, retry_after_ms: number | undefined): void {
  if ((err as Record<string, unknown>).statusCode !== 429) return;

  const fence = get_active_fence();
  if (!fence) return;

  const seconds = retry_after_ms !== undefined ? retry_after_ms / 1000 : DEFAULT_THROTTLE_SECONDS;
  fence.raise(seconds);
}

/** Extracts the Retry-After header value (in ms) from a Graph error, if present. */
function extract_retry_after(err: unknown): number | undefined {
  const graph_err = err as Record<string, unknown>;
  const headers_sources = [
    graph_err.headers as Record<string, string> | undefined,
    graph_err.responseHeaders as Record<string, string> | undefined,
    (graph_err.response as Record<string, unknown> | undefined)?.headers as
      Record<string, string> | undefined,
  ];
  for (const headers of headers_sources) {
    if (!headers) continue;
    const parsed = parse_retry_after_ms(headers['retry-after'] ?? headers['Retry-After']);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

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

/**
 * HTTP 404/410: the content is gone for good (version purged by retention,
 * item hard-deleted). Distinct from a transient failure -- callers count these
 * as expected, not as backup errors.
 */
export function is_content_gone_error(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const graph_err = err as Record<string, unknown>;
  const status = graph_err.statusCode ?? graph_err.status;
  if (status === 404 || status === 410) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('404') || message.includes('Not Found') || message.includes('410');
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
