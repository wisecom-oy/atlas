import type { IdentityRegistry, IdentityRegistryEntry } from '@wisecom/atlas-types';
import { normalize_registry_email } from '@/adapters/identity/identity-registry-merge';

/** One tenant's lookup maps. Built once from a stored registry and never mutated afterwards. */
export interface TenantIdentityIndex {
  readonly active_by_email: ReadonlyMap<string, IdentityRegistryEntry>;
  readonly by_object_id: ReadonlyMap<string, IdentityRegistryEntry>;
}

/** Indexes a registry as stored; an absent registry indexes as empty. */
export function build_tenant_identity_index(
  registry: IdentityRegistry | undefined,
): TenantIdentityIndex {
  const active_by_email = new Map<string, IdentityRegistryEntry>();
  const by_object_id = new Map<string, IdentityRegistryEntry>();
  for (const entry of registry?.entries ?? []) {
    by_object_id.set(entry.object_id, entry);
    if (entry.status === 'active') {
      active_by_email.set(normalize_registry_email(entry.email), entry);
    }
  }
  return { active_by_email, by_object_id };
}
