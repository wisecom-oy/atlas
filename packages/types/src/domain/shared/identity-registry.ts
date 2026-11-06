export type IdentityEntryStatus = 'active' | 'recycled';

export interface IdentityRegistryEntry {
  readonly object_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly registered_at: string;
  readonly status: IdentityEntryStatus;
}

export interface IdentityRegistry {
  readonly tenant_id: string;
  readonly entries: IdentityRegistryEntry[];
}
