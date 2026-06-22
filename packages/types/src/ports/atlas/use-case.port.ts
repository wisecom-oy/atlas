import type { StorageCheckRequest, StorageCheckResult } from '@/ports/storage-check/use-case.port';
import type { BucketStats } from '@/domain/stats';
import type { ReplicationResult, ReplicationStatusRecord } from '@/domain/replication';
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
}

export interface AtlasInstance {
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
  rehydrateTenant(source: StorageTarget): Promise<ReplicationResult>;
  getReplicationStatus(snapshotId?: string): Promise<ReplicationStatusRecord[]>;
  getReplicationStatusByMailbox(mailboxId: string): Promise<ReplicationStatusRecord[]>;
}
