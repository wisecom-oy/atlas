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
import { save_replication_status } from '@/services/replication/replication-status-repository';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';
import { build_drive_rehydration_plan } from '@/services/replication/drive-rehydration-plan';
import {
  build_skip_result,
  merge_replication_results,
} from '@/services/replication/replication-result-builder';
import {
  to_drive_status_record,
  collect_drive_ancillary_keys,
  group_manifests_by_owner,
  diff_drive_manifests,
} from '@/services/replication/drive-replication-result';
import {
  ONEDRIVE_REPLICATION,
  drive_manifest_key,
} from '@/services/replication/drive-replication-descriptor';
import type { AtlasConfig } from '@/utils/config';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import {
  copy_drive_snapshot_between,
  copy_drive_snapshot_into_context,
  copy_drive_snapshot_to_target,
} from '@/services/replication/drive-snapshot-copier';
import type { CopyDeps } from '@/services/replication/outlook-snapshot-copier';

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
      const ancillary = await collect_drive_ancillary_keys(
        ONEDRIVE_REPLICATION,
        source_ctx,
        owner_id,
      );
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const result = await copy_drive_snapshot_to_target(
          ONEDRIVE_REPLICATION,
          source_ctx,
          target,
          manifest,
          ancillary,
          this.copy_deps(tenant_id),
        );
        await save_replication_status(
          source_ctx,
          to_drive_status_record(ONEDRIVE_REPLICATION, result, target, manifest),
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
      const manifests = await this._onedrive_manifests.list_snapshots_by_owner(
        source_ctx,
        owner_id,
      );
      const ancillary = await collect_drive_ancillary_keys(
        ONEDRIVE_REPLICATION,
        source_ctx,
        owner_id,
      );
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const target_ctx = await target.create_context(tenant_id);
        try {
          // Once per target, not once per snapshot: whether the two buckets share a DEK does not
          // change between snapshots, and each check is two scrypt unwraps (issue #206).
          await this._validate_dek(
            source_ctx.storage,
            target_ctx.storage,
            this._config.encryption_passphrase,
            tenant_id,
          );
          const missing = await diff_drive_manifests(
            ONEDRIVE_REPLICATION,
            manifests,
            target_ctx,
            owner_id,
          );

          for (const manifest of missing) {
            const result = await copy_drive_snapshot_into_context(
              ONEDRIVE_REPLICATION,
              source_ctx,
              target_ctx,
              manifest,
              ancillary,
              target.target_id,
            );
            await save_replication_status(
              source_ctx,
              to_drive_status_record(ONEDRIVE_REPLICATION, result, target, manifest),
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
    await ensure_source_dek_on_primary(this.primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifest = await this.require_manifest(source_ctx, owner_id, snapshot_id);
      const manifest_key = drive_manifest_key(ONEDRIVE_REPLICATION, manifest);

      if (await primary_ctx.storage.exists(manifest_key)) {
        return build_skip_result(snapshot_id, source.target_id, manifest.entries.length);
      }

      const ancillary = await collect_drive_ancillary_keys(
        ONEDRIVE_REPLICATION,
        source_ctx,
        owner_id,
      );
      return copy_drive_snapshot_between(
        ONEDRIVE_REPLICATION,
        source_ctx,
        primary_ctx,
        manifest,
        ancillary,
        source.target_id,
        this.copy_deps(tenant_id),
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

  /** Deps every copy needs: this service's DEK validator, passphrase and tenant. */
  private copy_deps(tenant_id: string): CopyDeps {
    return {
      validate_dek: this._validate_dek,
      passphrase: this._config.encryption_passphrase,
      tenant_id,
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

  private async require_manifest(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest> {
    const m = await this._onedrive_manifests.find_by_snapshot(ctx, owner_id, snapshot_id);
    if (!m) {
      throw new Error(`No OneDrive manifest found for owner ${owner_id}, snapshot ${snapshot_id}`);
    }
    return m;
  }

  /** The primary bucket as a storage target. */
  private primary_target(): StorageTarget {
    return create_primary_target(this._target_factory, this._config);
  }
}
