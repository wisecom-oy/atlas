import { inject, injectable } from 'inversify';
import type {
  OwnerLeasePort,
  TenantContextFactory,
  TenantRewrapOutcome,
  TenantSetRewrapReport,
  TenantSetRewrapRequest,
  TenantSetRewrapUseCase,
} from '@wisecom/atlas-types';
import {
  NotFoundError,
  OWNER_LEASE_TOKEN,
  OwnerBusyError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { assert_usable_passphrase } from '@/services/keys/new-passphrase-policy';
import { rewrap_tenant_wrapper } from '@/services/keys/tenant-wrapper-rewrap';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import { logger } from '@/utils/logger';

/** Outcomes after which no key is left under the current passphrase. */
const SETTLED: ReadonlySet<TenantRewrapOutcome['status']> = new Set([
  'rewrapped',
  'already_rewrapped',
  'no_key',
]);

/**
 * Re-wraps every tenant key that shares one passphrase (issue #716).
 *
 * The passphrase is shared by every tenant profile, so re-wrapping one tenant strands the others
 * the moment the configured value changes. Tenants run one after another, each under its own
 * tenant lease, so a busy tenant is reported and skipped instead of stopping the rest.
 */
@injectable()
export class TenantSetRewrapService implements TenantSetRewrapUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /** Re-wraps each tenant still under the current passphrase and reports every outcome. */
  async rewrap_tenant_set(request: TenantSetRewrapRequest): Promise<TenantSetRewrapReport> {
    const passphrase_changed = request.current_passphrase !== request.next_passphrase;
    if (passphrase_changed) assert_usable_passphrase(request.next_passphrase);

    const outcomes: TenantRewrapOutcome[] = [];
    for (const tenant_id of new Set(request.tenant_ids)) {
      outcomes.push(await this.rewrap_one_tenant(tenant_id, request));
    }
    return {
      outcomes,
      passphrase_changed,
      complete: outcomes.every((outcome) => SETTLED.has(outcome.status)),
    };
  }

  /** One tenant under its tenant lease, with any failure turned into that tenant's outcome. */
  private async rewrap_one_tenant(
    tenant_id: string,
    request: TenantSetRewrapRequest,
  ): Promise<TenantRewrapOutcome> {
    try {
      const ctx = await this._tenant_factory.create_storage_only(tenant_id);
      return await run_with_owner_lease(
        this._leases,
        ctx,
        { workload: 'tenant', owner_id: tenant_id, operation: 'rewrap' },
        (lease) => rewrap_tenant_wrapper(ctx.storage, lease, tenant_id, request),
      );
    } catch (err) {
      return describe_tenant_failure(tenant_id, err);
    }
  }
}

/**
 * Turns a failure into the tenant's outcome. A missing bucket is not a failure: that tenant
 * holds no key under either passphrase.
 */
function describe_tenant_failure(tenant_id: string, err: unknown): TenantRewrapOutcome {
  if (err instanceof NotFoundError) return { tenant_id, status: 'no_key' };
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof OwnerBusyError) return { tenant_id, status: 'busy', detail };
  logger.warn(`Re-wrap of ${tenant_id} failed: ${detail}`);
  return { tenant_id, status: 'failed', detail };
}
