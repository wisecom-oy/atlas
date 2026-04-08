import type { TenantContext } from '@/ports/tenant/context.port';

export interface StorageTargetConfig {
  readonly target_id?: string;
  readonly s3_endpoint: string;
  readonly s3_access_key: string;
  readonly s3_secret_key: string;
  readonly s3_region?: string;
  readonly encryption_passphrase: string;
}

export interface StorageTarget {
  readonly target_id: string;
  readonly endpoint: string;
  /** Creates a tenant-scoped storage + crypto context on this target. */
  create_context(tenant_id: string): Promise<TenantContext>;
}
