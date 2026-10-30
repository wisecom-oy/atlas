import type { TenantContext } from '../tenant/context.port';
import type { IdentityRegistry } from '../../domain/identity-registry';

/**
 * Computes the next registry from the one currently stored, or `undefined` to leave it unchanged.
 *
 * Called again with fresh state whenever another writer changed the registry in between, so it
 * must be a pure function of its input.
 */
export type IdentityRegistryMutation = (
  current: IdentityRegistry | undefined,
) => IdentityRegistry | undefined;

export interface IdentityRegistryRepository {
  /** Loads the identity registry for the tenant, or undefined if none exists yet. */
  load(ctx: TenantContext): Promise<IdentityRegistry | undefined>;
  /**
   * Applies `mutate` to the stored registry as a compare-and-swap and returns what is stored
   * afterwards. A concurrent writer's change is re-read and `mutate` runs again on top of it, so
   * two processes registering different users both keep their entry.
   */
  update(
    ctx: TenantContext,
    mutate: IdentityRegistryMutation,
  ): Promise<IdentityRegistry | undefined>;
}
