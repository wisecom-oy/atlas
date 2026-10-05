import type { StorageUsage, StorageUsageBreakdown } from '@/domain/storage-usage';
import type { StorageTarget } from '@/ports/replication/storage-target.port';

export interface StorageUsageRequest {
  /** Measures this replication target instead of the primary storage. */
  readonly target?: StorageTarget | undefined;
  /** `owner` adds a per-owner and per-site breakdown. The workload breakdown is always present. */
  readonly breakdown?: StorageUsageBreakdown | undefined;
  /** Resumes a measurement that stopped early. */
  readonly continuation_token?: string | undefined;
  /** Stops at the next page boundary once this many S3 requests were made. */
  readonly max_list_requests?: number | undefined;
  /** Stops at the next page boundary once aborted. */
  readonly abort_signal?: AbortSignal | undefined;
}

/** The same request in the SDK's camelCase, with the SDK's `signal` spelling. */
export interface StorageUsageOptions {
  readonly target?: StorageTarget;
  readonly breakdown?: StorageUsageBreakdown;
  readonly continuationToken?: string;
  readonly maxListRequests?: number;
  readonly signal?: AbortSignal;
}

export interface StorageUsageUseCase {
  /** Lists the tenant bucket and reports the bytes it physically holds. */
  measure_storage_usage(tenant_id: string, request?: StorageUsageRequest): Promise<StorageUsage>;
}
