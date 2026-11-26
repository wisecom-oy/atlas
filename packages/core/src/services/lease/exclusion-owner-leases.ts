import type {
  HeldOwnerLease,
  OwnerExclusion,
  OwnerExclusionGrant,
  OwnerExclusionResult,
  OwnerLeasePort,
  OwnerLeaseRequest,
  TenantStorageContext,
} from '@wisecom/atlas-types';
import {
  ConfigError,
  OwnerBusyError,
  OwnerLeaseLostError,
  type OwnerExclusionRefusal,
} from '@wisecom/atlas-types';
import { owner_lease_key } from '@/services/lease/owner-lease-key';
import { logger } from '@/utils/logger';

/**
 * Owner leases granted by an exclusion outside the bucket: a host's own (`ownerExclusion`) or the
 * in-process one the CLI's single-writer mode uses (issue #974). Writes and reads no lease object,
 * so a versioned bucket keeps no lease versions or delete markers, and read-only credentials need
 * nothing extra. The storage context is used only for its tenant id.
 */
export class ExclusionOwnerLeases implements OwnerLeasePort {
  constructor(private readonly _exclusion: OwnerExclusion) {}

  /**
   * Asks the exclusion for the scope and turns a refusal into `OwnerBusyError`.
   *
   * @throws OwnerBusyError when the exclusion refuses the scope.
   * @throws ConfigError when the exclusion answers with something other than a grant or refusal.
   */
  async acquire(ctx: TenantStorageContext, request: OwnerLeaseRequest): Promise<HeldOwnerLease> {
    const result = await this._exclusion.acquire({
      tenantId: ctx.tenant_id,
      workload: request.workload,
      ownerId: request.owner_id,
      operation: request.operation,
    });
    const grant = require_grant(request, result);
    return new ExclusionHeldLease(
      owner_lease_key(request.workload, request.owner_id),
      request,
      grant,
    );
  }
}

/** A scope the exclusion granted, held until `release` or until the exclusion withdraws it. */
class ExclusionHeldLease implements HeldOwnerLease {
  private _released = false;

  constructor(
    readonly storage_key: string,
    private readonly _request: OwnerLeaseRequest,
    private readonly _grant: OwnerExclusionGrant,
  ) {}

  /** Fails once released, or when the exclusion says the scope is no longer this run's. */
  assert_held(): void {
    if (this._released) throw this.lost_error('it was already released');
    if (this._grant.isHeld?.() === false) {
      throw this.lost_error('the owner exclusion no longer grants it');
    }
  }

  /** Gives the scope back once. A failure is logged, never thrown. */
  async release(): Promise<void> {
    if (this._released) return;
    this._released = true;
    try {
      await this._grant.release();
    } catch (err) {
      logger.warn(
        `Could not release the owner exclusion on ${this._request.workload} owner ` +
          `${this._request.owner_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private lost_error(reason: string): OwnerLeaseLostError {
    return new OwnerLeaseLostError(
      { workload: this._request.workload, owner_id: this._request.owner_id },
      reason,
    );
  }
}

/** The grant inside `result`, or the busy error its refusal stands for. */
function require_grant(
  request: OwnerLeaseRequest,
  result: OwnerExclusionResult,
): OwnerExclusionGrant {
  if (result?.acquired === true && typeof result.release === 'function') return result;
  if (result?.acquired === false) throw owner_busy_error(request, result);
  throw new ConfigError(
    'ownerExclusion.acquire must resolve to { acquired: true, release } or { acquired: false }.',
  );
}

function owner_busy_error(
  request: OwnerLeaseRequest,
  refusal: OwnerExclusionRefusal,
): OwnerBusyError {
  return new OwnerBusyError({
    workload: request.workload,
    owner_id: request.owner_id,
    held_by_operation: refusal.heldByOperation,
    lease_expires_at: refusal.busyUntil,
  });
}
