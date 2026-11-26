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
  MessageExtendedProperties,
} from '@wisecom/atlas-types/ports/outlook/connector.port';
import type { MailboxPurpose } from '@wisecom/atlas-types/domain/outlook/manifest';
import type {
  MailboxRateLimiter,
  MailboxRateLimiterFactory,
} from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import {
  get_active_abort_signal,
  run_with_graph_operation,
  run_with_throttle_coordinator,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { get_active_graph_outage_signal } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import { GRAPH_SERVICE_LIMITS, ThrottledError } from '@wisecom/atlas-types';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { is_retry_after_above_cap_error } from '@/graph-retry-after';
import { link_signals } from '@/graph-attempt-cancellation';
import { run_with_uncharged_wait, wait_out_cooldown_before_send } from '@/graph-presend-cooldown';

const DELTA_WITH_TOKEN_COST = 1;
const DELTA_WITHOUT_TOKEN_COST = 2;
const DEFAULT_REQUEST_COST = 1;

export class RateLimitedGraphConnector implements MailboxConnector {
  private readonly _inner: MailboxConnector;
  private readonly _factory: MailboxRateLimiterFactory;
  private readonly _throttle: ThrottleCoordinator;
  private readonly _limiters = new Map<string, MailboxRateLimiter>();
  private _extended_properties_unsupported_logged = false;

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
    // GET /users -- Identity pool, not gated by per-mailbox semaphore, but still coordinated so
    // an identity 429 pauses the other identity requests of this instance.
    return run_with_throttle_coordinator(this._throttle, 'identity', () =>
      run_with_graph_operation(
        {
          pool: 'identity',
          request_type: 'list_users',
          resource_units: GRAPH_SERVICE_LIMITS.identity.users_list_cost,
        },
        () => this._inner.list_mailboxes(tenant_id),
      ),
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
   * Forwards the batched reaction and pin read (issues #481, #513, #579). Charged one unit per
   * message: Graph counts every request inside a `$batch` against the mailbox's limits, not the
   * round trip.
   */
  async fetch_extended_properties(
    tenant_id: string,
    owner_id: string,
    message_ids: readonly string[],
  ): Promise<Map<string, MessageExtendedProperties> | undefined> {
    const inner = this._inner;
    if (!inner.fetch_extended_properties) {
      if (!this._extended_properties_unsupported_logged) {
        this._extended_properties_unsupported_logged = true;
        logger.warn('The mailbox connector cannot read reactions or pins; they are not captured');
      }
      return undefined;
    }
    return this.rateLimited(owner_id, message_ids.length, () =>
      run_with_graph_operation({ pool: 'outlook', request_type: 'fetch_extended_properties' }, () =>
        inner.fetch_extended_properties!(tenant_id, owner_id, message_ids),
      ),
    );
  }

  /**
   * Stops callers parked on a mailbox's request window from keeping the process alive, for once
   * the command that sent them has ended (issue #859). They stay parked; nothing is sent early.
   */
  release_process_hold(): void {
    this._factory.release_process_hold();
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

  /**
   * Runs one connector call under the mailbox's cooldown and pacing. Published for the whole call so
   * the cooldown wait before the send, and the retry loop inside `fn`, both park on the mailbox's
   * cooldown and report each 429 against the pool the request declared. Nothing is raised here:
   * the retry loop already did, on the response that carried the 429, and it knows the pool while
   * this frame does not.
   */
  private async rateLimited<T>(owner_id: string, cost: number, fn: () => Promise<T>): Promise<T> {
    const owner = normalize_owner_id(owner_id);
    try {
      return await run_with_throttle_coordinator(
        this._throttle,
        'outlook',
        () => this.sendWhenAdmitted(owner, cost, fn),
        { ownerId: owner },
      );
    } catch (err) {
      // A Retry-After above the cap fails the call at once, so no retry budget was spent; the error
      // itself names the value (issue #873).
      if (err instanceof ThrottledError && !is_retry_after_above_cap_error(err)) {
        logger.warn(`Graph kept throttling mailbox ${owner_id} through the retry budget`);
      }
      throw err;
    }
  }

  /**
   * Waits out the mailbox cooldown, takes the mailbox's window tokens and a concurrency slot, then
   * sends `fn` with the cooldown wait charged to its retry budget (issue #884). Every wait ends at
   * once when the run is cancelled or has recorded a Graph outage, and `fn` is then never called,
   * so a stop never becomes an early request to a throttled mailbox (issue #874).
   */
  private async sendWhenAdmitted<T>(owner: string, cost: number, fn: () => Promise<T>): Promise<T> {
    const limiter = this.getLimiter(owner);
    const waited_ms = await this.waitForAdmission(limiter, cost);
    try {
      return await run_with_uncharged_wait(waited_ms, fn);
    } finally {
      limiter.release();
    }
  }

  /**
   * The waits before a call is sent: the cooldown first, so a parked call holds neither tokens nor
   * a slot, then the pacing. Resolves with the cooldown wait, which the call's budget is charged.
   */
  private async waitForAdmission(limiter: MailboxRateLimiter, cost: number): Promise<number> {
    const stop = link_signals(get_active_abort_signal(), get_active_graph_outage_signal());
    try {
      const waited_ms = await wait_out_cooldown_before_send(stop.signal);
      await limiter.acquire(cost, stop.signal);
      return waited_ms;
    } finally {
      stop.release();
    }
  }
}
