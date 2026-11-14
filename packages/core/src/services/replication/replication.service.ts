import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { ReplicationUseCase } from '@wisecom/atlas-types';
import type {
  OneDriveReplicationUseCase,
  SharePointReplicationUseCase,
} from '@wisecom/atlas-types';
import type { StorageTarget, StorageTargetFactory } from '@wisecom/atlas-types';
import type { DekValidationFn } from '@wisecom/atlas-types';
import type {
  ReplicationResult,
  ReplicationStatusRecord,
  TenantRehydrationResult,
  WorkloadRehydrationResult,
} from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import {
  replicate_drive_snapshot,
  rehydrate_drive_snapshot,
} from '@/services/replication/drive-snapshot-router';
import {
  rehydrate_outlook_snapshot_chain,
  replicate_outlook_mailbox_chain,
  replicate_outlook_snapshot_chain,
  type OutlookChainPorts,
} from '@/services/replication/outlook-chain-replication';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';
import {
  list_all_replication_status,
  list_replication_status_by_owner,
  list_replication_status_by_snapshot,
} from '@/services/replication/replication-status-repository';
import {
  list_mailbox_manifests,
  OUTLOOK_REHYDRATION,
} from '@/services/replication/outlook-manifest-handler';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { reject_teams_snapshot } from '@/services/replication/teams-snapshot-guard';
import { merge_replication_results } from '@/services/replication/replication-result-builder';
import type { AtlasConfig } from '@/utils/config';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { FullSnapshotReplicationService } from '@/services/replication/full-snapshot-replication.service';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

/** Scope label of a mailbox rehydration, which merges Outlook, contacts and calendar results. */
const MAILBOX_REHYDRATION_LABEL = 'full-mailbox';

@injectable()
export class ReplicationService implements ReplicationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(DEK_VALIDATION_FN_TOKEN) private readonly _validate_dek: DekValidationFn,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
    @inject(ONEDRIVE_REPLICATION_USE_CASE_TOKEN)
    private readonly _onedrive: OneDriveReplicationUseCase,
    @inject(SHAREPOINT_REPLICATION_USE_CASE_TOKEN)
    private readonly _sharepoint: SharePointReplicationUseCase,
    @inject(FullSnapshotReplicationService)
    private readonly _full_snapshots: FullSnapshotReplicationService,
  ) {}

  async replicate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    reject_teams_snapshot(snapshot_id);
    const source_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const drive = await replicate_drive_snapshot(source_ctx, tenant_id, snapshot_id, targets, {
        onedrive: this._onedrive,
        sharepoint: this._sharepoint,
      });
      if (drive !== undefined) return drive;

      return await replicate_outlook_snapshot_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        snapshot_id,
        targets,
      );
    } finally {
      source_ctx.destroy();
    }
  }

  /** Copies a mailbox's Outlook, contacts and calendar snapshots that each target lacks. */
  async replicate_mailbox(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    owner_id = normalize_owner_id(owner_id);
    const source_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const outlook = await replicate_outlook_mailbox_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        owner_id,
        targets,
      );
      const full_snapshots = await this._full_snapshots.replicate_mailbox(
        source_ctx,
        tenant_id,
        owner_id,
        targets,
      );
      return [...outlook, ...full_snapshots];
    } finally {
      source_ctx.destroy();
    }
  }

  async rehydrate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    reject_teams_snapshot(snapshot_id);
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const drive = await rehydrate_drive_snapshot(source_ctx, tenant_id, snapshot_id, source, {
        onedrive: this._onedrive,
        sharepoint: this._sharepoint,
      });
      if (drive !== undefined) return drive;

      return await rehydrate_outlook_snapshot_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        primary_ctx,
        snapshot_id,
        source,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** Recovers a mailbox's Outlook, contacts and calendar snapshots, reported as one result. */
  async rehydrate_mailbox(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    owner_id = normalize_owner_id(owner_id);
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await list_mailbox_manifests(this._manifests, source_ctx, owner_id);
      const outlook = await rehydrate_manifests(
        source_ctx,
        primary_ctx,
        manifests,
        source,
        tenant_id,
        this._validate_dek,
        this._config.encryption_passphrase,
        OUTLOOK_REHYDRATION,
      );
      const full_snapshots = await this._full_snapshots.rehydrate_mailbox(
        source_ctx,
        primary_ctx,
        tenant_id,
        owner_id,
        source,
      );
      return merge_replication_results(
        [outlook, ...full_snapshots.map((workload) => workload.result)],
        MAILBOX_REHYDRATION_LABEL,
        source.target_id,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /**
   * DR: recover every workload from a replica.
   *
   * Each workload keeps its manifests under its own prefix (`manifests/` for Outlook,
   * `contacts/manifests/`, `calendar/manifests/`, `onedrive/manifests/`, `sharepoint/manifests/`),
   * so enumerating one prefix recovers one workload. Each is recovered and reported separately.
   */
  async rehydrate_tenant(
    tenant_id: string,
    source: StorageTarget,
  ): Promise<TenantRehydrationResult> {
    const mailbox_workloads = await this.rehydrate_mailbox_workloads_tenant(tenant_id, source);
    const onedrive = await this._onedrive.rehydrate_all_owners(tenant_id, source);
    const sharepoint = await this._sharepoint.rehydrate_all_sites(tenant_id, source);

    const workloads: WorkloadRehydrationResult[] = [
      ...mailbox_workloads,
      { workload: 'onedrive', result: onedrive },
      { workload: 'sharepoint', result: sharepoint },
    ];

    return {
      total: merge_replication_results(
        workloads.map((w) => w.result),
        'full-tenant',
        source.target_id,
      ),
      workloads,
      unsupported_workloads: ['teams'],
    };
  }

  /** Recovers every mailbox's Outlook, contacts and calendar snapshots, one result each. */
  private async rehydrate_mailbox_workloads_tenant(
    tenant_id: string,
    source: StorageTarget,
  ): Promise<WorkloadRehydrationResult[]> {
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const all_manifests = await this._manifests.list_all_manifests(source_ctx);
      const outlook = await rehydrate_manifests(
        source_ctx,
        primary_ctx,
        all_manifests,
        source,
        tenant_id,
        this._validate_dek,
        this._config.encryption_passphrase,
        OUTLOOK_REHYDRATION,
      );
      const full_snapshots = await this._full_snapshots.rehydrate_tenant(
        source_ctx,
        primary_ctx,
        tenant_id,
        source,
      );
      return [{ workload: 'outlook', result: outlook }, ...full_snapshots];
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  async get_replication_status(
    tenant_id: string,
    snapshot_id?: string,
  ): Promise<ReplicationStatusRecord[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      if (snapshot_id) return await list_replication_status_by_snapshot(ctx, snapshot_id);
      return await list_all_replication_status(ctx);
    } finally {
      ctx.destroy();
    }
  }

  async get_replication_status_by_owner(
    tenant_id: string,
    owner_id: string,
  ): Promise<ReplicationStatusRecord[]> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await list_replication_status_by_owner(ctx, owner_id);
    } finally {
      ctx.destroy();
    }
  }

  private chain_ports(tenant_id: string): OutlookChainPorts {
    return {
      manifests: this._manifests,
      deps: {
        validate_dek: this._validate_dek,
        passphrase: this._config.encryption_passphrase,
        tenant_id,
      },
    };
  }

  /** The primary bucket as a storage target. */
  private primary_target(): StorageTarget {
    return create_primary_target(this._target_factory, this._config);
  }
}
