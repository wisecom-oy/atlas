import type { Manifest } from '@/domain/manifest';
import type { TenantContext, TenantStorageContext } from '@/ports/tenant/context.port';

export interface ManifestRepository {
  save(ctx: TenantContext, manifest: Manifest): Promise<void>;

  find_by_snapshot(ctx: TenantContext, snapshot_id: string): Promise<Manifest | undefined>;

  /** Returns the newest manifest for the given mailbox owner (storage prefix `manifests/{owner_id}/`). */
  find_latest_by_owner(ctx: TenantContext, owner_id: string): Promise<Manifest | undefined>;

  /** Downloads and decrypts every manifest in the tenant bucket. */
  list_all_manifests(ctx: TenantContext): Promise<Manifest[]>;

  /** Lists every owner with at least one manifest, from key names alone (no decryption). */
  list_owner_ids(ctx: TenantStorageContext): Promise<string[]>;
}
