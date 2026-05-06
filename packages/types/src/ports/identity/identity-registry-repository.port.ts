import type { TenantContext } from '../tenant/context.port';
import type { IdentityRegistry } from '../../domain/identity-registry';

export interface IdentityRegistryRepository {
  /** Loads the identity registry for the tenant, or undefined if none exists yet. */
  load(ctx: TenantContext): Promise<IdentityRegistry | undefined>;
  /** Persists the identity registry (overwrites previous state). */
  save(ctx: TenantContext, registry: IdentityRegistry): Promise<void>;
}
