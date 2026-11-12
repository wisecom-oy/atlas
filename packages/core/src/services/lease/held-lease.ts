import { OwnerLeaseLostError, type ObjectStorage } from '@wisecom/atlas-types';
import {
  encode_lease_record,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  type LeaseIdentity,
} from '@/services/lease/lease-record';
import { read_stored_lease, replace_lease_object } from '@/services/lease/lease-object-store';
import { is_precondition_failure } from '@/services/shared/precondition-failure';
import { logger } from '@/utils/logger';

/**
 * A lease this process holds: renews it in the background, knows when it was lost, and releases it.
 *
 * Lost means one of two things, and nothing else. A renewal was refused with 412, or the stored
 * lease no longer carries this run's token, so another run took it over. Or the local expiry passed
 * without a successful renewal, so another run may take it over at any moment. A renewal that fails
 * for a transient reason (network, 503) leaves the lease held until that expiry.
 */
export class HeldLease {
  /** Local clock time, taken before the last successful write was sent, plus one TTL. */
  private _held_until_ms: number;
  private _lost_reason: string | undefined;
  private _timer: NodeJS.Timeout | undefined;
  private _renewing: Promise<void> | undefined;

  constructor(
    private readonly _storage: ObjectStorage,
    readonly key: string,
    private readonly _identity: LeaseIdentity,
    held_until_ms: number,
  ) {
    this._held_until_ms = held_until_ms;
  }

  /** Starts the renewal timer. Unref'd, so a held lease never keeps the process alive. */
  start_renewal(): void {
    this._timer = setInterval(() => void this.renew_once(), LEASE_RENEW_INTERVAL_MS);
    this._timer.unref();
  }

  /** Stops the renewal timer and waits for a renewal already in flight. */
  async stop_renewal(): Promise<void> {
    if (this._timer !== undefined) clearInterval(this._timer);
    this._timer = undefined;
    await this._renewing;
  }

  /** @throws OwnerLeaseLostError once the lease is lost, or when its local expiry has passed. */
  assert_held(): void {
    if (this._lost_reason === undefined && Date.now() >= this._held_until_ms) {
      this.mark_lost('it expired before it could be renewed');
    }
    if (this._lost_reason !== undefined) {
      throw new OwnerLeaseLostError(this.key, this._lost_reason);
    }
  }

  /** Why the lease was lost, or undefined while it is held. Does not consult the clock. */
  lost_reason(): string | undefined {
    return this._lost_reason;
  }

  /** Renews once unless a renewal is already running. Exposed for the timer and for tests. */
  renew_once(): Promise<void> {
    this._renewing ??= this.renew().finally(() => {
      this._renewing = undefined;
    });
    return this._renewing;
  }

  /**
   * Deletes the lease when it is still this run's. Never throws: a lease left behind frees itself
   * at its expiry, and the run's own outcome must not be replaced by a cleanup failure.
   */
  async release(): Promise<void> {
    await this.stop_renewal();
    if (this._lost_reason !== undefined) return;
    try {
      const stored = await read_stored_lease(this._storage, this.key);
      if (stored?.record?.token !== this._identity.token) {
        logger.warn(`Run lease ${this.key} was taken over before release; leaving it in place`);
        return;
      }
      await this._storage.delete(this.key);
    } catch (err) {
      logger.warn(
        `Could not release run lease ${this.key}; it frees itself within ` +
          `${LEASE_TTL_MS / 60_000} minutes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async renew(): Promise<void> {
    if (this._lost_reason !== undefined) return;
    try {
      // Read before writing: on a backend that ignores If-Match, the token is what keeps this
      // renewal from overwriting a run that took the lease over.
      const stored = await read_stored_lease(this._storage, this.key);
      if (stored?.record?.token !== this._identity.token) {
        this.mark_lost('another run took it over');
        return;
      }
      const sent_at = Date.now();
      await replace_lease_object(
        this._storage,
        this.key,
        encode_lease_record(this._identity, sent_at),
        stored.etag,
      );
      const written = await read_stored_lease(this._storage, this.key);
      if (written?.record?.token !== this._identity.token) {
        this.mark_lost('another run took it over');
        return;
      }
      this._held_until_ms = sent_at + LEASE_TTL_MS;
    } catch (err) {
      if (is_precondition_failure(err)) {
        this.mark_lost('another run took it over');
        return;
      }
      logger.warn(
        `Could not renew run lease ${this.key}; retrying, and the run stops writing if it is ` +
          `still not renewed by ${new Date(this._held_until_ms).toISOString()}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private mark_lost(reason: string): void {
    if (this._lost_reason !== undefined) return;
    this._lost_reason = reason;
    logger.error(`Run lease ${this.key} lost: ${reason}. Further writes by this run are refused.`);
  }
}
