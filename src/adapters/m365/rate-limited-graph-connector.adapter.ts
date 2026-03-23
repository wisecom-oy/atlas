/**
 * Decorator around MailboxConnector that enforces per-mailbox rate limiting
 * and raises a global throttle fence on 429 responses.
 */

import type {
  MailboxConnector,
  MailFolder,
  MailMessage,
  DeltaSyncResult,
  DeltaPageCallback,
  MessageAttachment,
} from '@/ports/mailbox/connector.port';
import type {
  MailboxRateLimiter,
  MailboxRateLimiterFactory,
} from '@/services/shared/mailbox-rate-limiter';
import type { ThrottleFence } from '@/services/shared/throttle-fence';
import { logger } from '@/utils/logger';

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
    return this._inner.list_mailboxes(tenant_id);
  }

  async mailbox_exists(tenant_id: string, mailbox_id: string): Promise<boolean> {
    return this.rateLimited(mailbox_id, DEFAULT_REQUEST_COST, () =>
      this._inner.mailbox_exists(tenant_id, mailbox_id),
    );
  }

  async list_mail_folders(tenant_id: string, mailbox_id: string): Promise<MailFolder[]> {
    return this.rateLimited(mailbox_id, DEFAULT_REQUEST_COST, () =>
      this._inner.list_mail_folders(tenant_id, mailbox_id),
    );
  }

  async fetch_delta(
    tenant_id: string,
    mailbox_id: string,
    folder_id: string,
    prev_delta_link?: string,
    on_page?: DeltaPageCallback,
    page_size?: number,
  ): Promise<DeltaSyncResult> {
    const cost = prev_delta_link ? DELTA_WITH_TOKEN_COST : DELTA_WITHOUT_TOKEN_COST;
    return this.rateLimited(mailbox_id, cost, () =>
      this._inner.fetch_delta(
        tenant_id,
        mailbox_id,
        folder_id,
        prev_delta_link,
        on_page,
        page_size,
      ),
    );
  }

  async fetch_message(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
  ): Promise<MailMessage> {
    return this.rateLimited(mailbox_id, DEFAULT_REQUEST_COST, () =>
      this._inner.fetch_message(tenant_id, mailbox_id, message_id),
    );
  }

  async fetch_attachments(
    tenant_id: string,
    mailbox_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]> {
    return this.rateLimited(mailbox_id, DEFAULT_REQUEST_COST, () =>
      this._inner.fetch_attachments(tenant_id, mailbox_id, message_id),
    );
  }

  /** Shuts down all per-mailbox limiters. */
  shutdown(): void {
    this._factory.shutdown_all();
    this._limiters.clear();
  }

  private getLimiter(mailbox_id: string): MailboxRateLimiter {
    let limiter = this._limiters.get(mailbox_id);
    if (!limiter) {
      limiter = this._factory.create();
      this._limiters.set(mailbox_id, limiter);
    }
    return limiter;
  }

  private async rateLimited<T>(mailbox_id: string, cost: number, fn: () => Promise<T>): Promise<T> {
    const limiter = this.getLimiter(mailbox_id);
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
