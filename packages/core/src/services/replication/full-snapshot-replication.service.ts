import { inject, injectable } from 'inversify';
import type {
  CalendarManifestRepository,
  CalendarSnapshotManifest,
  ContactsManifestRepository,
  ContactsSnapshotManifest,
  DekValidationFn,
  ReplicationResult,
  StorageTarget,
  TenantContext,
  WorkloadRehydrationResult,
} from '@wisecom/atlas-types';
import {
  CALENDAR_MANIFEST_REPOSITORY_TOKEN,
  CONTACTS_MANIFEST_REPOSITORY_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
} from '@wisecom/atlas-types';
import type { CopyDeps } from '@/services/replication/chain-replication-runner';
import {
  calendar_replication,
  contacts_replication,
  full_snapshot_mailbox_prefix,
  type FullSnapshotReplicaManifest,
  type FullSnapshotReplicationDescriptor,
} from '@/services/replication/full-snapshot-replication-descriptor';
import {
  list_full_snapshots,
  rehydrate_full_snapshots,
  replicate_full_snapshots,
} from '@/services/replication/full-snapshot-replication';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';

/**
 * Replicates and rehydrates the contacts and calendar snapshots of a mailbox or a whole tenant
 * (issue #715). Each snapshot is a full view of the mailbox, so each is copied as a chain of one.
 *
 * Callers open the contexts and hold the leases; this service only copies between them.
 */
@injectable()
export class FullSnapshotReplicationService {
  private readonly _contacts: FullSnapshotReplicationDescriptor<ContactsSnapshotManifest>;
  private readonly _calendar: FullSnapshotReplicationDescriptor<CalendarSnapshotManifest>;

  constructor(
    @inject(CONTACTS_MANIFEST_REPOSITORY_TOKEN) contacts: ContactsManifestRepository,
    @inject(CALENDAR_MANIFEST_REPOSITORY_TOKEN) calendar: CalendarManifestRepository,
    @inject(DEK_VALIDATION_FN_TOKEN) private readonly _validate_dek: DekValidationFn,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {
    this._contacts = contacts_replication(contacts);
    this._calendar = calendar_replication(calendar);
  }

  /** Copies a mailbox's contacts, then calendar snapshots, that each target lacks. */
  async replicate_mailbox(
    source_ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    targets: readonly StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const deps = this.copy_deps(tenant_id);
    const replicate = async <T extends FullSnapshotReplicaManifest>(
      descriptor: FullSnapshotReplicationDescriptor<T>,
    ): Promise<ReplicationResult[]> => {
      const prefix = full_snapshot_mailbox_prefix(descriptor, mailbox_id);
      const listing = await list_full_snapshots(descriptor, source_ctx, prefix);
      return replicate_full_snapshots(source_ctx, listing, targets, deps);
    };
    return [...(await replicate(this._contacts)), ...(await replicate(this._calendar))];
  }

  /** Recovers a mailbox's contacts and calendar snapshots from a replica, one result each. */
  async rehydrate_mailbox(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    source: StorageTarget,
  ): Promise<WorkloadRehydrationResult[]> {
    return this.rehydrate_each_workload(source_ctx, primary_ctx, tenant_id, source, (descriptor) =>
      full_snapshot_mailbox_prefix(descriptor, mailbox_id),
    );
  }

  /** Recovers every mailbox's contacts and calendar snapshots from a replica, one result each. */
  async rehydrate_tenant(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    tenant_id: string,
    source: StorageTarget,
  ): Promise<WorkloadRehydrationResult[]> {
    return this.rehydrate_each_workload(
      source_ctx,
      primary_ctx,
      tenant_id,
      source,
      (descriptor) => `${descriptor.manifest_root}/`,
    );
  }

  /** Rehydrates contacts, then calendar, from the manifests under the prefix each scope names. */
  private async rehydrate_each_workload(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    tenant_id: string,
    source: StorageTarget,
    prefix_of: (descriptor: { readonly manifest_root: string }) => string,
  ): Promise<WorkloadRehydrationResult[]> {
    const deps = this.copy_deps(tenant_id);
    const rehydrate = async <T extends FullSnapshotReplicaManifest>(
      descriptor: FullSnapshotReplicationDescriptor<T>,
    ): Promise<WorkloadRehydrationResult> => {
      const listing = await list_full_snapshots(descriptor, source_ctx, prefix_of(descriptor));
      const result = await rehydrate_full_snapshots(source_ctx, primary_ctx, listing, source, deps);
      return { workload: descriptor.workload, result };
    };
    return [await rehydrate(this._contacts), await rehydrate(this._calendar)];
  }

  private copy_deps(tenant_id: string): CopyDeps {
    return {
      validate_dek: this._validate_dek,
      passphrase: this._config.encryption_passphrase,
      tenant_id,
    };
  }
}
