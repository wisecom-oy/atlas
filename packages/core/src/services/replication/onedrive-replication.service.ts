import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import type { OneDriveManifestRepository, OneDriveSnapshotManifest } from '@wisecom/atlas-types';
import type { StorageTarget, StorageTargetFactory } from '@wisecom/atlas-types';
import type { DekValidationFn } from '@wisecom/atlas-types';
import type { ReplicationResult } from '@wisecom/atlas-types';
import type { OneDriveReplicationUseCase } from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';
import { build_drive_rehydration_plan } from '@/services/replication/drive-chain-copy-plan';
import {
  rehydrate_drive_snapshot_chain,
  replicate_drive_owner_chain,
  replicate_drive_snapshot_chain,
  type DriveChainPorts,
} from '@/services/replication/drive-chain-replication';
import { merge_replication_results } from '@/services/replication/replication-result-builder';
import {
  collect_drive_ancillary_keys,
  group_manifests_by_owner,
} from '@/services/replication/drive-replication-result';
import { ONEDRIVE_REPLICATION } from '@/services/replication/drive-replication-descriptor';
import type { AtlasConfig } from '@/utils/config';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

@injectable()
export class OneDriveReplicationService implements OneDriveReplicationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _onedrive_manifests: OneDriveManifestRepository,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(DEK_VALIDATION_FN_TOKEN) private readonly _validate_dek: DekValidationFn,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
  ) {}

  /** Replicates one OneDrive snapshot with every older snapshot of its owner a target lacks. */
  async replicate_owner(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    owner_id = normalize_owner_id(owner_id);
    const source_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await replicate_drive_snapshot_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        owner_id,
        snapshot_id,
        targets,
      );
    } finally {
      source_ctx.destroy();
    }
  }

  /** Replicates all unreplicated OneDrive snapshots for an owner, oldest first. */
  async replicate_all_owner_snapshots(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    owner_id = normalize_owner_id(owner_id);
    const source_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifests = await this._onedrive_manifests.list_snapshots_by_owner(
        source_ctx,
        owner_id,
      );
      return await replicate_drive_owner_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        owner_id,
        manifests,
        targets,
      );
    } finally {
      source_ctx.destroy();
    }
  }

  /** DR: recover a specific OneDrive snapshot, and the older ones it builds on, from a replica. */
  async rehydrate_owner_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    owner_id = normalize_owner_id(owner_id);
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      return await rehydrate_drive_snapshot_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        primary_ctx,
        owner_id,
        snapshot_id,
        source,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** DR: recover all OneDrive snapshots for an owner from a replica. */
  async rehydrate_owner(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    owner_id = normalize_owner_id(owner_id);
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await this._onedrive_manifests.list_snapshots_by_owner(
        source_ctx,
        owner_id,
      );
      const ancillary = await collect_drive_ancillary_keys(
        ONEDRIVE_REPLICATION,
        source_ctx,
        owner_id,
      );

      return this.rehydrate_owner_manifests(
        source_ctx,
        primary_ctx,
        manifests,
        ancillary,
        source,
        tenant_id,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** DR: recover every OneDrive owner's snapshots from a replica. */
  async rehydrate_all_owners(tenant_id: string, source: StorageTarget): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const all = await this._onedrive_manifests.list_all_manifests(source_ctx);
      const by_owner = group_manifests_by_owner(ONEDRIVE_REPLICATION, all);

      const results: ReplicationResult[] = [];
      for (const [owner_id, manifests] of by_owner) {
        const ancillary = await collect_drive_ancillary_keys(
          ONEDRIVE_REPLICATION,
          source_ctx,
          owner_id,
        );
        results.push(
          await this.rehydrate_owner_manifests(
            source_ctx,
            primary_ctx,
            manifests,
            ancillary,
            source,
            tenant_id,
          ),
        );
      }

      return merge_replication_results(results, `${by_owner.size}-owners`, source.target_id);
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** This workload's replication wiring, with this service's DEK validator and passphrase. */
  private chain_ports(tenant_id: string): DriveChainPorts<OneDriveSnapshotManifest> {
    return {
      descriptor: ONEDRIVE_REPLICATION,
      lookup: {
        workload: 'OneDrive',
        find_by_snapshot: (ctx, owner_id, snapshot_id) =>
          this._onedrive_manifests.find_by_snapshot(ctx, owner_id, snapshot_id),
        list_snapshot_summaries: (ctx, owner_id) =>
          this._onedrive_manifests.list_snapshot_summaries(ctx, owner_id),
        read_manifest_at: (ctx, key) => this._onedrive_manifests.read_manifest_at(ctx, key),
      },
      deps: {
        validate_dek: this._validate_dek,
        passphrase: this._config.encryption_passphrase,
        tenant_id,
      },
    };
  }

  /** Rehydrates one owner's manifests, supplying this service's DEK validator and passphrase. */
  private rehydrate_owner_manifests(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    manifests: OneDriveSnapshotManifest[],
    ancillary_keys: string[],
    source: StorageTarget,
    tenant_id: string,
  ): Promise<ReplicationResult> {
    const plan = build_drive_rehydration_plan(ONEDRIVE_REPLICATION, ancillary_keys);
    return rehydrate_manifests(
      source_ctx,
      primary_ctx,
      manifests,
      source,
      tenant_id,
      this._validate_dek,
      this._config.encryption_passphrase,
      plan,
    );
  }

  /** The primary bucket as a storage target. */
  private primary_target(): StorageTarget {
    return create_primary_target(this._target_factory, this._config);
  }
}
