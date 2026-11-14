import { inject, injectable } from 'inversify';
import type {
  OldWrapperPurgeReport,
  OldWrapperPurgeRequest,
  OldWrapperPurgeUseCase,
  OwnerLeasePort,
  TenantContextFactory,
  TenantWrapperPurgeOutcome,
} from '@wisecom/atlas-types';
import {
  NotFoundError,
  OWNER_LEASE_TOKEN,
  OwnerBusyError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { purge_tenant_old_wrappers, type PurgeKeys } from '@/services/keys/wrapper-version-purge';
import { run_with_owner_lease } from '@/services/lease/run-with-owner-lease';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';
import { logger } from '@/utils/logger';

/**
 * Deletes the noncurrent versions of `_meta/dek.enc` that a re-wrap leaves behind (issue #716).
 *
 * A re-wrap writes a new current version and keeps the old one on a versioned bucket, and that
 * old version still opens with the passphrase the re-wrap was meant to retire. Each tenant runs
 * under its own tenant lease, taken as a `rewrap`, so no re-wrap or owner operation of that tenant
 * runs while its versions are listed and deleted.
 */
@injectable()
export class OldWrapperPurgeService implements OldWrapperPurgeUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /** Purges each tenant's old wrappers and reports every version it kept and why. */
  async purge_old_wrappers(request: OldWrapperPurgeRequest): Promise<OldWrapperPurgeReport> {
    const keys: PurgeKeys = {
      configured: new EnvelopeKeyService(this._config.encryption_passphrase),
      previous: request.previous_passphrases.map((p) => new EnvelopeKeyService(p)),
    };
    try {
      const outcomes: TenantWrapperPurgeOutcome[] = [];
      for (const tenant_id of new Set(request.tenant_ids)) {
        outcomes.push(await this.purge_one_tenant(tenant_id, keys));
      }
      const complete = outcomes.every((o) => o.status === 'purged' || o.status === 'no_key');
      return { outcomes, complete };
    } finally {
      keys.configured.destroy();
      for (const previous of keys.previous) previous.destroy();
    }
  }

  /** One tenant under its tenant lease, with any failure turned into that tenant's outcome. */
  private async purge_one_tenant(
    tenant_id: string,
    keys: PurgeKeys,
  ): Promise<TenantWrapperPurgeOutcome> {
    try {
      const ctx = await this._tenant_factory.create_storage_only(tenant_id);
      return await run_with_owner_lease(
        this._leases,
        ctx,
        { workload: 'tenant', owner_id: tenant_id, operation: 'rewrap' },
        () => purge_tenant_old_wrappers(ctx.storage, tenant_id, keys),
      );
    } catch (err) {
      return describe_purge_failure(tenant_id, err);
    }
  }
}

/** Turns a failure into the tenant's outcome. A missing bucket holds no wrapper to purge. */
function describe_purge_failure(tenant_id: string, err: unknown): TenantWrapperPurgeOutcome {
  if (err instanceof NotFoundError) return { tenant_id, status: 'no_key', versions: [] };
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof OwnerBusyError) return { tenant_id, status: 'busy', versions: [], detail };
  logger.warn(`Purging old wrappers of ${tenant_id} failed: ${detail}`);
  return { tenant_id, status: 'failed', versions: [], detail };
}
