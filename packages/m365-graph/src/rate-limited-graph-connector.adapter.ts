/**
 * Decorator around MailboxConnector that enforces per-mailbox rate limiting,
 * reports 429 responses to the instance's ThrottleCoordinator, and records every Graph
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
  MailFolderListOptions,
  MailMessage,
  DeltaSyncResult,
  DeltaPageCallback,
  MessageAttachment,
} from '@wisecom/atlas-types/ports/mail/connector.port';
import type { ExtendedProperty, MailboxPurpose } from '@wisecom/atlas-types/domain/manifest';
import type {
  MailboxRateLimiter,
  MailboxRateLimiterFactory,
} from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import {
  run_with_graph_operation,
  run_with_throttle_coordinator,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { GRAPH_SERVICE_LIMITS, ThrottledError } from '@wisecom/atlas-types';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

const DELTA_WITH_TOKEN_COST = 1;
const DELTA_WITHOUT_TOKEN_COST = 2;
const DEFAULT_REQUEST_COST = 1;

export class RateLimitedGraphConnector implements MailboxConnector {
  private readonly _inner: MailboxConnector;
  private readonly _factory: MailboxRateLimiterFactory;
  private readonly _throttle: ThrottleCoordinator;
  private readonly _limiters = new Map<string, MailboxRateLimiter>();
  private _reactions_unsupported_logged = false;

  constructor(
    inner: MailboxConnector,
    factory: MailboxRateLimiterFactory,
    throttle: ThrottleCoordinator,
  ) {
    this._inner = inner;
    this._factory = factory;
    this._throttle = throttle;
  }

  async list_mailboxes(tenant_id: string): Promise<string[]> {
    // GET /users -- Identity pool, not gated by per-mailbox semaphore
    return run_with_graph_operation(
      {
        pool: 'identity',
        request_type: 'list_users',
        resource_units: GRAPH_SERVICE_LIMITS.identity.users_list_cost,
      },
      () => this._inner.list_mailboxes(tenant_id),
    );
  }

  async mailbox_exists(tenant_id: string, owner_id: string): Promise<boolean> {
    // GET /users/{id} -- Identity pool
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () =>
      run_with_graph_operation(
        {
          pool: 'identity',
          request_type: 'mailbox_exists',
          resource_units: GRAPH_SERVICE_LIMITS.identity.user_get_cost,
        },
        () => this._inner.mailbox_exists(tenant_id, owner_id),
      ),
    );
  }

  async get_mailbox_purpose(
    tenant_id: string,
    owner_id: string,
  ): Promise<MailboxPurpose | undefined> {
    if (!this._inner.get_mailbox_purpose) return undefined;
    // GET /users/{id}/mailboxSettings -- Identity pool
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () =>
      run_with_graph_operation(
        {
          pool: 'identity',
          request_type: 'get_mailbox_purpose',
          resource_units: GRAPH_SERVICE_LIMITS.identity.user_get_cost,
        },
        () => this._inner.get_mailbox_purpose!(tenant_id, owner_id),
      ),
    );
  }

  async list_mail_folders(
    tenant_id: string,
    owner_id: string,
    options?: MailFolderListOptions,
  ): Promise<MailFolder[]> {
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'list_folders' }, () =>
        this._inner.list_mail_folders(tenant_id, owner_id, options),
      ),
    );
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
    return this.rateLimited(owner_id, cost, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'delta_sync' }, () =>
        this._inner.fetch_delta(
          tenant_id,
          owner_id,
          folder_id,
          prev_delta_link,
          on_page,
          page_size,
        ),
      ),
    );
  }

  async fetch_message(
    tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MailMessage> {
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'fetch_message' }, () =>
        this._inner.fetch_message(tenant_id, owner_id, message_id),
      ),
    );
  }

  async fetch_attachments(
    tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]> {
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'fetch_attachments' }, () =>
        this._inner.fetch_attachments(tenant_id, owner_id, message_id),
      ),
    );
  }

  /**
   * Forwards the MIME capture (issue #50). Counted as a full message read
   * against the outlook pool, because that is what /$value costs.
   */
  async fetch_mime(
    tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<Buffer | undefined> {
    if (!this._inner.fetch_mime) return undefined;
    return this.rateLimited(owner_id, DEFAULT_REQUEST_COST, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'fetch_mime' }, () =>
        this._inner.fetch_mime!(tenant_id, owner_id, message_id),
      ),
    );
  }

  /**
   * Forwards the batched reaction read (issues #481, #513). Charged one unit per message: Graph
   * counts every request inside a `$batch` against the mailbox's limits, not the round trip.
   */
  async fetch_reaction_properties(
    tenant_id: string,
    owner_id: string,
    message_ids: readonly string[],
  ): Promise<Map<string, ExtendedProperty[]> | undefined> {
    const inner = this._inner;
    if (!inner.fetch_reaction_properties) {
      if (!this._reactions_unsupported_logged) {
        this._reactions_unsupported_logged = true;
        logger.warn('The mailbox connector cannot read reactions; they are not captured');
      }
      return undefined;
    }
    return this.rateLimited(owner_id, message_ids.length, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'fetch_reaction_properties' }, () =>
        inner.fetch_reaction_properties!(tenant_id, owner_id, message_ids),
      ),
    );
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
      // Published so the retry loop inside `fn` parks on the cooldown between
      // its own attempts. acquire() above only covers the first one.
      return await run_with_throttle_coordinator(this._throttle, 'outlook', fn);
    } catch (err) {
      this.handleThrottle(err);
      throw err;
    } finally {
      limiter.release();
    }
  }

  private handleThrottle(err: unknown): void {
    // An exhausted 429 arrives as ThrottledError; the Graph response with its headers is the cause.
    const graph_err = (err instanceof ThrottledError ? err.cause : err) as
      Record<string, unknown> | undefined;
    if (graph_err?.statusCode !== 429) return;

    const headers = graph_err.headers as Record<string, string> | undefined;
    const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const seconds = raw ? parseInt(raw, 10) : 30;
    const duration = isNaN(seconds) || seconds <= 0 ? 30 : seconds;

    logger.warn(`Graph 429 received -- pausing Outlook requests for ${duration}s`);
    this._throttle.raise('outlook', duration * 1000);
  }
}
