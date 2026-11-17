import type { HeldOwnerLease, OwnerLeaseRequest, TenantStorageContext } from '@wisecom/atlas-types';
import { OwnerLeaseLostError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import type { AcquiredOwnerLease } from '@/services/lease/owner-lease-acquirer';
import {
  put_owner_lease,
  read_owner_lease,
  type OwnerLeaseRecord,
} from '@/services/lease/owner-lease-record';
import {
  OWNER_LEASE_COMMIT_MARGIN_MS,
  OWNER_LEASE_RENEW_INTERVAL_MS,
  OWNER_LEASE_TTL_MS,
  type OwnerLeaseRuntime,
} from '@/services/lease/owner-lease-timing';
import { logger } from '@/utils/logger';

/**
 * A lease this run holds, renewed on a timer until it is released.
 *
 * The lease is lost only on evidence: storage holds another holder's lease or none, a renewal's
 * compare-and-swap was refused, or the lease's own expiry passed without a successful renewal. A
 * storage failure during a renewal is not evidence, and the next tick tries again.
 */
export class RenewingOwnerLease implements HeldOwnerLease {
  readonly storage_key: string;
  private readonly _record: OwnerLeaseRecord;
  private _expires_at_ms: number;
  private _lost_reason: string | undefined;
  private _released = false;
  private _renewal: Promise<void> | undefined;
  private readonly _stop_renewing: () => void;

  constructor(
    private readonly _ctx: TenantStorageContext,
    private readonly _request: OwnerLeaseRequest,
    acquired: AcquiredOwnerLease,
    private readonly _runtime: OwnerLeaseRuntime,
  ) {
    this.storage_key = acquired.key;
    this._record = acquired.record;
    this._expires_at_ms = Date.parse(acquired.record.expires_at);
    this._stop_renewing = _runtime.schedule(
      () => this.start_renewal(),
      OWNER_LEASE_RENEW_INTERVAL_MS,
    );
  }

  /** Fails when the lease was lost, released, or is within the commit margin of its expiry. */
  assert_held(): void {
    if (this._released) this.mark_lost('it was already released');
    if (this._runtime.now() >= this._expires_at_ms - OWNER_LEASE_COMMIT_MARGIN_MS) {
      this.mark_lost('it could not be renewed before it expired');
    }
    if (this._lost_reason === undefined) return;
    throw new OwnerLeaseLostError(
      { workload: this._request.workload, owner_id: this._request.owner_id },
      this._lost_reason,
    );
  }

  /**
   * Stops renewing, waits for a renewal in flight, and gives the lease back when storage still
   * shows this run as its holder: by deleting it, or by marking it released in place when the
   * delete is refused. A lease that was lost or has expired is left alone: another operation may
   * own it by now. A failure is logged, never thrown, so it cannot mask the run's own outcome.
   */
  async release(): Promise<void> {
    if (this._released) return;
    this._released = true;
    this._stop_renewing();
    try {
      await this._renewal;
      if (this._lost_reason !== undefined || this._runtime.now() >= this._expires_at_ms) return;
      const stored = await read_owner_lease(this._ctx, this.storage_key);
      if (stored?.record?.holder_id !== this._record.holder_id) return;
      await this.delete_or_mark_released(stored.etag);
    } catch (err) {
      logger.warn(
        `Could not release the lease at ${this.storage_key}; it expires on its own at ` +
          `${new Date(this._expires_at_ms).toISOString()}: ${error_text(err)}`,
      );
    }
  }

  /**
   * Deletes the lease, or when the delete fails rewrites it as released and already expired, with
   * a compare-and-swap on the ETag just read. A bucket policy that denies `DeleteObject` on
   * `_meta/*` protects the data key and also refuses this delete; the owner must not stay busy
   * for a whole lifetime after every run because of it. A refused swap means the lease changed
   * hands, which needs nothing further. Rejects only when both the delete and the write fail.
   */
  private async delete_or_mark_released(etag: string): Promise<void> {
    try {
      await this._ctx.storage.delete(this.storage_key);
      return;
    } catch (delete_error) {
      const released_at = new Date(this._runtime.now()).toISOString();
      const released: OwnerLeaseRecord = { ...this._record, expires_at: released_at, released_at };
      try {
        await put_owner_lease(this._ctx, this.storage_key, released, { if_match: etag });
      } catch (write_error) {
        throw new Error(
          `the delete failed (${error_text(delete_error)}) and marking it released failed ` +
            `(${error_text(write_error)})`,
        );
      }
    }
  }

  /** Starts one renewal unless one is running or the lease is no longer held. */
  private start_renewal(): void {
    if (this._renewal !== undefined || this._released || this._lost_reason !== undefined) return;
    this._renewal = this.renew_once().finally(() => {
      this._renewal = undefined;
    });
  }

  /** Extends the lease by one TTL, or records why it can no longer be. Never rejects. */
  private async renew_once(): Promise<void> {
    try {
      if (this._runtime.now() >= this._expires_at_ms) {
        this.mark_lost('it expired before it could be renewed');
        return;
      }
      const stored = await read_owner_lease(this._ctx, this.storage_key);
      if (stored?.record?.holder_id !== this._record.holder_id) {
        this.mark_lost(
          stored === undefined ? 'it was removed from storage' : 'another operation replaced it',
        );
        return;
      }
      await this.extend_stored_lease(stored.etag);
    } catch (err) {
      if (err instanceof UnsupportedFormatVersionError) {
        this.mark_lost('a newer Atlas replaced it');
        return;
      }
      logger.warn(
        `Could not renew the lease at ${this.storage_key}; retrying in ` +
          `${OWNER_LEASE_RENEW_INTERVAL_MS / 1000} s: ${error_text(err)}`,
      );
    }
  }

  /** Rewrites the lease with a new expiry, conditional on the ETag this run just read. */
  private async extend_stored_lease(etag: string): Promise<void> {
    const extended: OwnerLeaseRecord = {
      ...this._record,
      expires_at: new Date(this._runtime.now() + OWNER_LEASE_TTL_MS).toISOString(),
    };
    const outcome = await put_owner_lease(this._ctx, this.storage_key, extended, {
      if_match: etag,
    });
    if (outcome === 'written') {
      this._expires_at_ms = Date.parse(extended.expires_at);
      return;
    }
    // A refused swap is this run's own write when the storage client retried a PUT whose response
    // was lost. Anything else stored under the key means the lease changed hands.
    const current = await read_owner_lease(this._ctx, this.storage_key);
    if (current?.record?.holder_id !== this._record.holder_id) {
      this.mark_lost('another operation replaced it');
      return;
    }
    this._expires_at_ms = Date.parse(current.record.expires_at);
  }

  /** Records the first reason the lease was lost and stops renewing it. */
  private mark_lost(reason: string): void {
    if (this._lost_reason !== undefined) return;
    this._lost_reason = reason;
    this._stop_renewing();
    if (!this._released) {
      logger.warn(
        `Lost the lease on ${this._request.workload} owner ${this._request.owner_id}: ${reason}`,
      );
    }
  }
}

function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
