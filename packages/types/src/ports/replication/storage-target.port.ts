import type { TenantContext } from '@/ports/tenant/context.port';

/**
 * camelCase, matching `AtlasInstanceConfig`. The factory is bound in the DI container by symbol,
 * which is untyped, so a second snake_case spelling of this shape is not a synonym: it resolves
 * to `undefined` fields at runtime and an S3 client with no credentials (issue #377).
 */
export interface StorageTargetConfig {
  readonly targetId?: string;
  readonly s3Endpoint: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region?: string;
  readonly encryptionPassphrase: string;
}

export interface StorageTarget {
  readonly target_id: string;
  readonly endpoint: string;
  /** Creates a tenant-scoped storage + crypto context on this target. */
  create_context(tenant_id: string): Promise<TenantContext>;
}

/** Creates a StorageTarget from configuration. */
export type StorageTargetFactory = (config: StorageTargetConfig) => StorageTarget;
