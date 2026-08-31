import type { LogSink } from '@/ports/atlas/log-sink.port';
import type { StorageCheckRequest, StorageCheckResult } from '@/ports/storage-check/use-case.port';
import type { BucketStats } from '@/domain/stats';
import type {
  ReplicationResult,
  ReplicationStatusRecord,
  TenantRehydrationResult,
} from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';
import type { OutlookApi } from '@/ports/atlas/outlook-api.port';
import type { OneDriveApi } from '@/ports/atlas/onedrive-api.port';
import type { SharePointApi } from '@/ports/atlas/sharepoint-api.port';
import type { ResolvedUserIdentity } from '@/ports/identity/user-identity-resolver.port';
import type { IdentityRegistry } from '@/domain/identity-registry';

export interface AtlasInstanceConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly s3Endpoint: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region?: string;
  readonly encryptionPassphrase: string;
  /**
   * Where Atlas sends log output. Omitted means silent: an embedded Atlas
   * writes nothing to the host's stdout unless the host asks for it (issue #41).
   */
  readonly logger?: LogSink;
}

export interface AtlasInstance extends AsyncDisposable {
  readonly outlook: OutlookApi;
  readonly onedrive: OneDriveApi;
  readonly sharepoint: SharePointApi;

  checkStorage(request?: StorageCheckRequest): Promise<StorageCheckResult>;
  getBucketStats(): Promise<BucketStats>;
  resolveUser(email: string): Promise<ResolvedUserIdentity>;
  listUsers(): Promise<IdentityRegistry | undefined>;
  replicateSnapshot(snapshotId: string, targets: StorageTarget[]): Promise<ReplicationResult[]>;
  replicateMailbox(mailboxId: string, targets: StorageTarget[]): Promise<ReplicationResult[]>;
  rehydrateSnapshot(snapshotId: string, source: StorageTarget): Promise<ReplicationResult>;
  rehydrateMailbox(mailboxId: string, source: StorageTarget): Promise<ReplicationResult>;
  /** Full tenant recovery across Outlook, OneDrive, and SharePoint, reported per workload. */
  rehydrateTenant(source: StorageTarget): Promise<TenantRehydrationResult>;
  getReplicationStatus(snapshotId?: string): Promise<ReplicationStatusRecord[]>;
  /**
   * Releases the instance: S3 socket pools, cached bucket state, container
   * bindings. Idempotent. The instance must not be used afterwards.
   *
   * A service creating one instance per tenant otherwise accumulates keep-alive
   * socket pools for the lifetime of the process (issue #42).
   */
  dispose(): Promise<void>;

  getReplicationStatusByOwner(mailboxId: string): Promise<ReplicationStatusRecord[]>;
}
