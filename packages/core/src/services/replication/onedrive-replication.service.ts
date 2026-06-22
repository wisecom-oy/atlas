import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@atlas/types';
import type { OneDriveManifestRepository, OneDriveSnapshotManifest } from '@atlas/types';
import type { StorageTarget, StorageTargetFactory } from '@atlas/types';
import type { DekValidationFn } from '@atlas/types';
import type { ReplicationResult } from '@atlas/types';
import type { OneDriveReplicationUseCase } from '@atlas/types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
} from '@atlas/types';
import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { save_replication_status } from '@/services/replication/replication-status-repository';
import { ensure_source_dek_on_primary } from '@/services/replication/rehydration-dek-helper';
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
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await this._od_manifests.list_snapshots_by_owner(source_ctx, owner_id);
      const ancillary = await collect_od_ancillary_keys(source_ctx, owner_id);

      return this.rehydrate_manifests(
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

  private async rehydrate_manifests(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    manifests: OneDriveSnapshotManifest[],
    ancillary_keys: string[],
    source: StorageTarget,
    tenant_id: string,
  ): Promise<ReplicationResult> {
    const start = Date.now();
    await this._validate_dek(
      source_ctx.storage,
      primary_ctx.storage,
      this._config.encryption_passphrase,
      tenant_id,
    );

    let total_copied = 0;
    let total_skipped = 0;
    let total_failed = 0;
    let total_bytes = 0;
    const all_errors: string[] = [];
    let snapshot_count = 0;

    for (const manifest of manifests) {
      const key = `${OD_MANIFEST_PREFIX}/${manifest.owner_id}/${manifest.snapshot_id}.json`;
      if (await primary_ctx.storage.exists(key)) {
        total_skipped++;
        continue;
      }

      const rep = await replicate_onedrive_snapshot(source_ctx, primary_ctx, manifest, key, {
        skip_marker: true,
        ancillary_keys,
      });
      total_copied += rep.objects_copied;
      total_skipped += rep.objects_skipped;
      total_failed += rep.objects_failed;
      total_bytes += rep.bytes_copied;
      all_errors.push(...rep.errors);
      snapshot_count++;
    }

    const label =
      manifests.length === 1 ? manifests[0]!.snapshot_id : `${snapshot_count}-snapshots`;
    return build_replication_result(
      {
        objects_copied: total_copied,
        objects_skipped: total_skipped,
        objects_failed: total_failed,
        bytes_copied: total_bytes,
        errors: all_errors,
      },
      label,
      source.target_id,
      Date.now() - start,
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
