import type {
  IdentityRegistry,
  IdentityRegistryEntry,
  ResolvedUserIdentity,
} from '@wisecom/atlas-types';

/** What applying a Graph identity to the stored registry did. */
export type IdentityMergeOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'registered' }
  | { readonly kind: 'recycled'; readonly previous_object_id: string };

export interface IdentityMergeResult {
  readonly registry: IdentityRegistry;
  readonly outcome: IdentityMergeOutcome;
}

/** Lower-cases and trims an email the way every registry lookup compares it. */
export function normalize_registry_email(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Makes `identity` the active entry for its email in `current`.
 *
 * Decided against the stored registry rather than this process's cached copy, so it is safe to
 * re-run after another writer changed the registry: an identity someone else already registered
 * comes back `unchanged` instead of being added twice.
 */
export function merge_active_identity(
  current: IdentityRegistry | undefined,
  tenant_id: string,
  identity: ResolvedUserIdentity,
  registered_at: string,
): IdentityMergeResult {
  const entries = current?.entries ?? [];
  const email = normalize_registry_email(identity.email);
  const active = entries.find((e) => e.status === 'active' && e.email === email);

  if (active?.object_id === identity.object_id) {
    return { registry: current ?? { tenant_id, entries }, outcome: { kind: 'unchanged' } };
  }

  const added: IdentityRegistryEntry = {
    object_id: identity.object_id,
    email,
    display_name: identity.display_name,
    registered_at,
    status: 'active',
  };
  const kept = entries.map((e) => (e === active ? { ...e, status: 'recycled' as const } : e));
  const registry = { tenant_id, entries: [...kept, added] };

  return active
    ? { registry, outcome: { kind: 'recycled', previous_object_id: active.object_id } }
    : { registry, outcome: { kind: 'registered' } };
}
