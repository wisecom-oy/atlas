import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import type {
  SharePointManifestRepository,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import type { StorageTarget, StorageTargetFactory } from '@wisecom/atlas-types';
import type { DekValidationFn } from '@wisecom/atlas-types';
import type { ReplicationResult } from '@wisecom/atlas-types';
import type { SharePointReplicationUseCase } from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
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
import type { AtlasConfig } from '@/utils/config';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

import {
  collect_drive_ancillary_keys,
  group_manifests_by_owner,
} from '@/services/replication/drive-replication-result';
import { SHAREPOINT_REPLICATION } from '@/services/replication/drive-replication-descriptor';

@injectable()
export class SharePointReplicationService implements SharePointReplicationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _sharepoint_manifests: SharePointManifestRepository,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(DEK_VALIDATION_FN_TOKEN) private readonly _validate_dek: DekValidationFn,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
  ) {}

  /** Replicates one SharePoint snapshot with every older snapshot of its site a target lacks. */
  async replicate_site(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    site_id = normalize_owner_id(site_id);
    const source_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await replicate_drive_snapshot_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        site_id,
        snapshot_id,
        targets,
      );
    } finally {
      source_ctx.destroy();
    }
  }

  /** Replicates all unreplicated SharePoint snapshots for a site, oldest first. */
  async replicate_all_site_snapshots(
    tenant_id: string,
    site_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    site_id = normalize_owner_id(site_id);
    const source_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifests = await this._sharepoint_manifests.list_snapshots_by_site(
        source_ctx,
        site_id,
      );
      return await replicate_drive_owner_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        site_id,
        manifests,
        targets,
      );
    } finally {
      source_ctx.destroy();
    }
  }

  /** DR: recover a specific SharePoint snapshot, and the older ones it builds on, from a replica. */
  async rehydrate_site_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    site_id = normalize_owner_id(site_id);
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      return await rehydrate_drive_snapshot_chain(
        this.chain_ports(tenant_id),
        source_ctx,
        primary_ctx,
        site_id,
        snapshot_id,
        source,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** DR: recover all SharePoint snapshots for a site from a replica. */
  async rehydrate_site(
    tenant_id: string,
    site_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    site_id = normalize_owner_id(site_id);
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await this._sharepoint_manifests.list_snapshots_by_site(
        source_ctx,
        site_id,
      );
      const ancillary = await collect_drive_ancillary_keys(
        SHAREPOINT_REPLICATION,
        source_ctx,
        site_id,
      );

      return this.rehydrate_site_manifests(
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

  /** DR: recover every SharePoint site's snapshots from a replica. */
  async rehydrate_all_sites(tenant_id: string, source: StorageTarget): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const all = await this._sharepoint_manifests.list_all_manifests(source_ctx);
      const by_site = group_manifests_by_owner(SHAREPOINT_REPLICATION, all);

      const results: ReplicationResult[] = [];
      for (const [site_id, manifests] of by_site) {
        const ancillary = await collect_drive_ancillary_keys(
          SHAREPOINT_REPLICATION,
          source_ctx,
          site_id,
        );
        results.push(
          await this.rehydrate_site_manifests(
            source_ctx,
            primary_ctx,
            manifests,
            ancillary,
            source,
            tenant_id,
          ),
        );
      }

      return merge_replication_results(results, `${by_site.size}-sites`, source.target_id);
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** This workload's replication wiring, with this service's DEK validator and passphrase. */
  private chain_ports(tenant_id: string): DriveChainPorts<SharePointSnapshotManifest> {
    return {
      descriptor: SHAREPOINT_REPLICATION,
      lookup: {
        workload: 'SharePoint',
        find_by_snapshot: (ctx, site_id, snapshot_id) =>
          this._sharepoint_manifests.find_by_snapshot(ctx, site_id, snapshot_id),
        list_snapshot_summaries: (ctx, site_id) =>
          this._sharepoint_manifests.list_snapshot_summaries(ctx, site_id),
        read_manifest_at: (ctx, key) => this._sharepoint_manifests.read_manifest_at(ctx, key),
      },
      deps: {
        validate_dek: this._validate_dek,
        passphrase: this._config.encryption_passphrase,
        tenant_id,
      },
    };
  }

  /** Rehydrates one site's manifests, supplying this service's DEK validator and passphrase. */
  private rehydrate_site_manifests(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    manifests: SharePointSnapshotManifest[],
    ancillary_keys: string[],
    source: StorageTarget,
    tenant_id: string,
  ): Promise<ReplicationResult> {
    const plan = build_drive_rehydration_plan(SHAREPOINT_REPLICATION, ancillary_keys);
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
