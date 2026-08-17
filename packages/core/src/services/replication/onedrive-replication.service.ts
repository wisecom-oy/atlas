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
import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { save_replication_status } from '@/services/replication/replication-status-repository';
import { ensure_source_dek_on_primary } from '@/services/replication/rehydration-dek-helper';
import { rehydrate_od_manifests } from '@/services/replication/rehydration-od-manifests-runner';
import { group_manifests_by_scope } from '@/services/replication/manifest-grouping';
import {
  replicate_every_scope,
  rehydrate_every_scope,
} from '@/services/replication/tenant-scope-fanout';
import {
  build_replication_result,
  build_skip_result,
} from '@/services/replication/replication-result-builder';
import {
  OD_MANIFEST_PREFIX,
  to_onedrive_status_record,
  collect_od_ancillary_keys,
  diff_od_manifests,
} from '@/services/replication/onedrive-replication-helpers';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

@injectable()
export class OneDriveReplicationService implements OneDriveReplicationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _od_manifests: OneDriveManifestRepository,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(DEK_VALIDATION_FN_TOKEN) private readonly _validate_dek: DekValidationFn,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
  ) {}

  /** Replicates a single sealed OneDrive snapshot. */
  async replicate_owner(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    owner_id = normalize_owner_id(owner_id);
    const source_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this.require_manifest(source_ctx, owner_id, snapshot_id);
      const ancillary = await collect_od_ancillary_keys(source_ctx, owner_id);
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const result = await this.copy_to_target(
          source_ctx,
          target,
          manifest,
          ancillary,
          tenant_id,
        );
        await save_replication_status(
          source_ctx,
          to_onedrive_status_record(result, target, manifest),
        );
        results.push(result);
      }

      return results;
    } finally {
      source_ctx.destroy();
    }
  }

  /** Replicates all unreplicated OneDrive snapshots for an owner. */
  async replicate_all_owner_snapshots(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    owner_id = normalize_owner_id(owner_id);
    const source_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifests = await this._od_manifests.list_snapshots_by_owner(source_ctx, owner_id);
      const ancillary = await collect_od_ancillary_keys(source_ctx, owner_id);
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const target_ctx = await target.create_context(tenant_id);
        try {
          const missing = await diff_od_manifests(manifests, target_ctx, owner_id);

          for (const manifest of missing) {
            const result = await this.copy_to_target(
              source_ctx,
              target,
              manifest,
              ancillary,
              tenant_id,
            );
            await save_replication_status(
              source_ctx,
              to_onedrive_status_record(result, target, manifest),
            );
            results.push(result);
          }
        } finally {
          target_ctx.destroy();
        }
      }

      return results;
    } finally {
      source_ctx.destroy();
    }
  }

  /** DR: recover a specific OneDrive snapshot from a replica. */
  async rehydrate_owner_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    owner_id = normalize_owner_id(owner_id);
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifest = await this.require_manifest(source_ctx, owner_id, snapshot_id);
      const manifest_key = `${OD_MANIFEST_PREFIX}/${owner_id}/${snapshot_id}.json`;

      if (await primary_ctx.storage.exists(manifest_key)) {
        return build_skip_result(snapshot_id, source.target_id);
      }

      const ancillary = await collect_od_ancillary_keys(source_ctx, owner_id);
      return this.copy_between(
        source_ctx,
        primary_ctx,
        manifest,
        ancillary,
        source.target_id,
        tenant_id,
        true,
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
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await this._od_manifests.list_snapshots_by_owner(source_ctx, owner_id);
      const ancillary = await collect_od_ancillary_keys(source_ctx, owner_id);

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
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const all = await this._od_manifests.list_all_manifests(source_ctx);
      return await rehydrate_every_scope(
        group_manifests_by_scope(all, (m) => m.owner_id),
        'owners',
        source.target_id,
        async (owner_id, manifests) =>
          this.rehydrate_owner_manifests(
            source_ctx,
            primary_ctx,
            manifests,
            await collect_od_ancillary_keys(source_ctx, owner_id),
            source,
            tenant_id,
          ),
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** Replicates every unreplicated OneDrive snapshot for every owner in the tenant. */
  async replicate_all_owners(
    tenant_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    return replicate_every_scope(
      this._tenant_factory,
      tenant_id,
      (ctx) => this._od_manifests.list_all_manifests(ctx),
      (m) => m.owner_id,
      (owner_id) => this.replicate_all_owner_snapshots(tenant_id, owner_id, targets),
    );
  }

  private async copy_to_target(
    source_ctx: TenantContext,
    target: StorageTarget,
    manifest: OneDriveSnapshotManifest,
    ancillary_keys: string[],
    tenant_id: string,
  ): Promise<ReplicationResult> {
    const start = Date.now();
    const target_ctx = await target.create_context(tenant_id);
    await this._validate_dek(
      source_ctx.storage,
      target_ctx.storage,
      this._config.encryption_passphrase,
      tenant_id,
    );
    const manifest_key = `${OD_MANIFEST_PREFIX}/${manifest.owner_id}/${manifest.snapshot_id}.json`;
    const rep = await replicate_onedrive_snapshot(source_ctx, target_ctx, manifest, manifest_key, {
      ancillary_keys,
    });
    return build_replication_result(
      rep,
      manifest.snapshot_id,
      target.target_id,
      Date.now() - start,
    );
  }

  private async copy_between(
    source_ctx: TenantContext,
    target_ctx: TenantContext,
    manifest: OneDriveSnapshotManifest,
    ancillary_keys: string[],
    target_id: string,
    tenant_id: string,
    is_rehydration = false,
  ): Promise<ReplicationResult> {
    const start = Date.now();
    await this._validate_dek(
      source_ctx.storage,
      target_ctx.storage,
      this._config.encryption_passphrase,
      tenant_id,
    );
    const manifest_key = `${OD_MANIFEST_PREFIX}/${manifest.owner_id}/${manifest.snapshot_id}.json`;
    const rep = await replicate_onedrive_snapshot(source_ctx, target_ctx, manifest, manifest_key, {
      skip_marker: is_rehydration,
      ancillary_keys,
    });
    return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
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
    return rehydrate_od_manifests(
      source_ctx,
      primary_ctx,
      manifests,
      ancillary_keys,
      source,
      tenant_id,
      this._validate_dek,
      this._config.encryption_passphrase,
    );
  }

  private async require_manifest(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest> {
    const m = await this._od_manifests.find_by_snapshot(ctx, owner_id, snapshot_id);
    if (!m) {
      throw new Error(`No OneDrive manifest found for owner ${owner_id}, snapshot ${snapshot_id}`);
    }
    return m;
  }

  private create_primary_target(): StorageTarget {
    return this._target_factory({
      s3_endpoint: this._config.s3_endpoint,
      s3_access_key: this._config.s3_access_key,
      s3_secret_key: this._config.s3_secret_key,
      s3_region: this._config.s3_region,
      encryption_passphrase: this._config.encryption_passphrase,
    });
  }
}
