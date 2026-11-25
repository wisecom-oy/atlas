import type { LogSink } from '@/ports/atlas/log-sink.port';
import type { StorageRequestObserver } from '@/ports/storage/storage-request-observer.port';
import type { ThrottleCoordinator } from '@/ports/shared/throttle-coordinator.port';
import type { StorageCheckRequest, StorageCheckResult } from '@/ports/storage-check/use-case.port';
import type { BucketStats } from '@/domain/stats/stats';
import type { StorageUsage } from '@/domain/stats/storage-usage';
import type { StorageUsageOptions } from '@/ports/storage-usage/use-case.port';
import type { DekRewrapResult } from '@/ports/keys/dek-rewrap.port';
import type { OutlookApi } from '@/ports/outlook/api.port';
import type { OneDriveApi } from '@/ports/onedrive/api.port';
import type { ContactsApi } from '@/ports/contacts/api.port';
import type { CalendarApi } from '@/ports/calendar/api.port';
import type { SharePointApi } from '@/ports/sharepoint/api.port';
import type { TeamsApi } from '@/ports/teams/api.port';
import type { KeysApi } from '@/ports/keys/api.port';
import type { ResolvedUserIdentity } from '@/ports/identity/user-identity-resolver.port';
import type { IdentityRegistry } from '@/domain/shared/identity-registry';
import type { Camelize } from '@/public/case-convert';

export interface AtlasInstanceConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly s3Endpoint: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region?: string;
  /**
   * Bucket to use instead of the derived `atlas-<tenantId>`, such as a provider replica under
   * another name. Bound to `tenantId`: opening any other tenant on this instance is refused, and
   * a missing bucket is an error rather than created.
   */
  readonly s3Bucket?: string;
  /**
   * Milliseconds for a TCP connection to the S3 endpoint to open, from 1000 to 600000, or 0 for
   * no timeout. Defaults to 10000.
   */
  readonly s3ConnectionTimeoutMs?: number;
  /**
   * Milliseconds an S3 request's socket may stay silent, nothing sent and nothing received, before
   * the attempt is cut off, from 1000 to 3600000, or 0 for no timeout. Defaults to 300000. A slow
   * transfer that keeps moving bytes never reaches it.
   */
  readonly s3IdleTimeoutMs?: number;
  /** Attempts per S3 request, the first one included, from 1 to 10. Defaults to 3. */
  readonly s3MaxAttempts?: number;
  readonly encryptionPassphrase: string;
  /**
   * Where Atlas sends log output. Omitted means silent: an embedded Atlas
   * writes nothing to the host's stdout unless the host asks for it (issue #41).
   */
  readonly logger?: LogSink;
  /**
   * Receives one event per S3 request this instance sends, with timing, retry, size and outcome.
   * Omitted means nothing is measured and the storage path is unchanged.
   */
  readonly onStorageRequest?: StorageRequestObserver;
  /**
   * Coordinates Graph 429 cooldowns. Omitted means one in-memory cooldown per throttling pool,
   * shared by this instance's operations. Supply one backed by shared state when several
   * processes run operations for the same tenant.
   */
  readonly throttleCoordinator?: ThrottleCoordinator;
  /**
   * Share of the tenant-wide Teams pacing budget this instance uses, above 0 and at most 1.
   * Defaults to 1. Set it to `1 / n` when `n` processes back up teams of the same tenant.
   */
  readonly teamsPacingShare?: number;
}

export interface AtlasInstance extends AsyncDisposable {
  readonly outlook: OutlookApi;
  readonly onedrive: OneDriveApi;
  readonly sharepoint: SharePointApi;
  readonly teams: TeamsApi;
  readonly contacts: ContactsApi;
  readonly calendar: CalendarApi;
  /** Re-wraps and purges data-key wrappers across every tenant that shares the passphrase. */
  readonly keys: KeysApi;

  /**
   * Checks tenant-bucket access, the existing wrapped key when present, and Graph token issuance.
   * Rejects with StorageError for S3 failures, WrongPassphraseError when the configured
   * passphrase cannot unwrap an existing tenant key, or AuthError for token failures. A fresh
   * tenant with no wrapped key still passes; validation never provisions storage or key material.
   */
  validate(): Promise<void>;
  checkStorage(request?: Camelize<StorageCheckRequest>): Promise<Camelize<StorageCheckResult>>;
  getBucketStats(): Promise<Camelize<BucketStats>>;
  /**
   * Lists the tenant bucket on the configured endpoint and reports the bytes it physically holds: current and noncurrent versions, delete markers, staging and incomplete
   * uploads, per workload and optionally per owner.
   */
  getStorageUsage(options?: StorageUsageOptions): Promise<Camelize<StorageUsage>>;
  resolveUser(email: string): Promise<Camelize<ResolvedUserIdentity>>;
  listUsers(): Promise<Camelize<IdentityRegistry> | undefined>;
  /**
   * Re-wraps the tenant's stored data key under `newPassphrase`, or under the configured one
   * with current KDF parameters when it is omitted.
   *
   * The data key is unchanged, so no stored object is re-encrypted and every snapshot stays
   * readable. This rotates the wrapper, not the key.
   */
  rewrapDataKey(newPassphrase?: string): Promise<Camelize<DekRewrapResult>>;
  /**
   * Releases the instance: S3 socket pools, cached bucket state, container
   * bindings. Idempotent. The instance must not be used afterwards.
   *
   * A service creating one instance per tenant otherwise accumulates keep-alive
   * socket pools for the lifetime of the process (issue #42).
   */
  dispose(): Promise<void>;
}
