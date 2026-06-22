/**
 * Decorator around MailboxConnector that enforces per-mailbox rate limiting,
 * raises a global throttle fence on 429 responses, and records every Graph
 * request to the active GraphRequestCounter (if any).
 *
 * Pool attribution:
 *  - list_mail_folders, fetch_delta, fetch_message, fetch_attachments -> outlook pool
 *  - mailbox_exists, list_mailboxes -> identity pool (/users endpoints)
 *
 * @see https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits
 */

import type {
  MailboxConnector,
  MailFolder,
  MailMessage,
  DeltaSyncResult,
  DeltaPageCallback,
  MessageAttachment,
} from '@wisecom/atlas-types/ports/mail/connector.port';
import type {
  MailboxRateLimiter,
  MailboxRateLimiterFactory,
} from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import type { ThrottleFence } from '@wisecom/atlas-core/services/shared/throttle-fence';
import { get_active_counter } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

const DELTA_WITH_TOKEN_COST = 1;
const DELTA_WITHOUT_TOKEN_COST = 2;
const DEFAULT_REQUEST_COST = 1;

export class RateLimitedGraphConnector implements MailboxConnector {
  private readonly _inner: MailboxConnector;
  private readonly _factory: MailboxRateLimiterFactory;
  private readonly _fence: ThrottleFence;
  private readonly _limiters = new Map<string, MailboxRateLimiter>();

  constructor(inner: MailboxConnector, factory: MailboxRateLimiterFactory, fence: ThrottleFence) {
    this._inner = inner;
    this._factory = factory;
    this._fence = fence;
  }

  async list_mailboxes(tenant_id: string): Promise<string[]> {
    // GET /users -- Identity pool, not gated by per-mailbox semaphore
    get_active_counter()?.record('identity', 'list_users', {
      resource_units: GRAPH_SERVICE_LIMITS.identity.users_list_cost,
    });
    return this._inner.list_mailboxes(tenant_id);
  }

  async mailbox_exists(tenant_id: string, owner_id: string): Promise<boolean> {
    // GET /users/{id} -- Identity pool
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () => {
      get_active_counter()?.record('identity', 'mailbox_exists', {
        resource_units: GRAPH_SERVICE_LIMITS.identity.user_get_cost,
      });
      return this._inner.mailbox_exists(tenant_id, owner_id);
    });
  }

  async list_mail_folders(tenant_id: string, owner_id: string): Promise<MailFolder[]> {
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () => {
      get_active_counter()?.record('outlook', 'list_folders');
      return this._inner.list_mail_folders(tenant_id, owner_id);
    });
  }

  async fetch_delta(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    prev_delta_link?: string,
    on_page?: DeltaPageCallback,
    page_size?: number,
  ): Promise<DeltaSyncResult> {
    const cost = prev_delta_link ? DELTA_WITH_TOKEN_COST : DELTA_WITHOUT_TOKEN_COST;
    return this.rateLimited(owner_id, cost, () => {
      get_active_counter()?.record('outlook', 'delta_sync');
      return this._inner.fetch_delta(
        tenant_id,
        owner_id,
        folder_id,
        prev_delta_link,
        on_page,
        page_size,
      );
    });
  }

  async fetch_message(
    tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MailMessage> {
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () => {
      get_active_counter()?.record('outlook', 'fetch_message');
      return this._inner.fetch_message(tenant_id, owner_id, message_id);
    });
  }

  async fetch_attachments(
    tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]> {
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () => {
      get_active_counter()?.record('outlook', 'fetch_attachments');
      return this._inner.fetch_attachments(tenant_id, owner_id, message_id);
    });
  }

  /** Shuts down all per-mailbox limiters. */
  shutdown(): void {
    this._factory.shutdown_all();
    this._limiters.clear();
  }

  private getLimiter(owner_id: string): MailboxRateLimiter {
    let limiter = this._limiters.get(owner_id);
    if (!limiter) {
      limiter = this._factory.create();
      this._limiters.set(owner_id, limiter);
    }
    return limiter;
  }

  private async rateLimited<T>(owner_id: string, cost: number, fn: () => Promise<T>): Promise<T> {
    const limiter = this.getLimiter(owner_id);
    await limiter.acquire(cost);
    try {
      return await fn();
    } catch (err) {
      this.handleThrottle(err);
      throw err;
    } finally {
      limiter.release();
    }
  }

  private handleThrottle(err: unknown): void {
    const graph_err = err as Record<string, unknown>;
    if (graph_err.statusCode !== 429) return;

    const headers = graph_err.headers as Record<string, string> | undefined;
    const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const seconds = raw ? parseInt(raw, 10) : 30;
    const duration = isNaN(seconds) || seconds <= 0 ? 30 : seconds;

    logger.warn(`Graph 429 received -- raising throttle fence for ${duration}s`);
    this._fence.raise(duration);
  }
}
