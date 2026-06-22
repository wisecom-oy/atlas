import type { ObjectLockMode } from '@/ports/backup/use-case.port';

export interface StorageCheckRequest {
  readonly mode?: ObjectLockMode | undefined;
  readonly retention_days?: number | undefined;
}

export interface StorageCheckResult {
  readonly bucket: string;
  readonly reachable: boolean;
  readonly versioning_enabled: boolean;
  readonly object_lock_enabled: boolean;
  readonly mode_supported: boolean;
  readonly requested_mode?: ObjectLockMode | undefined;
  readonly requested_retention_days?: number | undefined;
  readonly resolved_retain_until?: string | undefined;
}

export interface StorageCheckUseCase {
  check_storage(tenant_id: string, request?: StorageCheckRequest): Promise<StorageCheckResult>;
}
