import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import {
  copy_drive_snapshot_between,
  copy_drive_snapshot_into_context,
  copy_drive_snapshot_to_target,
} from '@/services/replication/drive-snapshot-copier';
import type { CopyDeps } from '@/services/replication/outlook-snapshot-copier';
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
import { save_replication_status } from '@/services/replication/replication-status-repository';
import { ensure_source_dek_on_primary } from '@/services/replication/dek-rehydration-validator';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';
import { build_drive_rehydration_plan } from '@/services/replication/drive-rehydration-plan';
import {
  build_skip_result,
  merge_replication_results,
} from '@/services/replication/replication-result-builder';
import type { AtlasConfig } from '@/utils/config';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

import {
  to_drive_status_record,
  collect_drive_ancillary_keys,
  group_manifests_by_owner,
  diff_drive_manifests,
} from '@/services/replication/drive-replication-result';
import {
  SHAREPOINT_REPLICATION,
  drive_manifest_key,
} from '@/services/replication/drive-replication-descriptor';

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

  /** Replicates a single sealed SharePoint snapshot. */
  async replicate_site(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    site_id = normalize_owner_id(site_id);
    const source_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this.require_sharepoint_manifest(source_ctx, site_id, snapshot_id);
      const ancillary = await collect_drive_ancillary_keys(
        SHAREPOINT_REPLICATION,
        source_ctx,
        site_id,
      );
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const result = await copy_drive_snapshot_to_target(
          SHAREPOINT_REPLICATION,
          source_ctx,
          target,
          manifest,
          ancillary,
          this.copy_deps(tenant_id),
        );
        await save_replication_status(
          source_ctx,
          to_drive_status_record(SHAREPOINT_REPLICATION, result, target, manifest),
        );
        results.push(result);
      }

      return results;
    } finally {
      source_ctx.destroy();
    }
  }

  /** Replicates all unreplicated SharePoint snapshots for a site. */
  async replicate_all_site_snapshots(
    tenant_id: string,
    site_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    site_id = normalize_owner_id(site_id);
    const source_ctx = await this._tenant_factory.create(tenant_id);
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
            SHAREPOINT_REPLICATION,
            manifests,
            target_ctx,
            site_id,
          );

          for (const manifest of missing) {
            const result = await copy_drive_snapshot_into_context(
              SHAREPOINT_REPLICATION,
              source_ctx,
              target_ctx,
              manifest,
              ancillary,
              target.target_id,
            );
            await save_replication_status(
              source_ctx,
              to_drive_status_record(SHAREPOINT_REPLICATION, result, target, manifest),
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

  /** DR: recover a specific SharePoint snapshot from a replica. */
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
      const manifest = await this.require_sharepoint_manifest(
        source_ctx,
        site_id,
        snapshot_id,
        'source',
      );
      const manifest_key = drive_manifest_key(SHAREPOINT_REPLICATION, manifest);

      if (await primary_ctx.storage.exists(manifest_key)) {
        return build_skip_result(snapshot_id, source.target_id, manifest.entries.length);
      }

      const ancillary = await collect_drive_ancillary_keys(
        SHAREPOINT_REPLICATION,
        source_ctx,
        site_id,
      );
      return copy_drive_snapshot_between(
        SHAREPOINT_REPLICATION,
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

  /** Deps every copy needs: this service's DEK validator, passphrase and tenant. */
  private copy_deps(tenant_id: string): CopyDeps {
    return {
      validate_dek: this._validate_dek,
      passphrase: this._config.encryption_passphrase,
      tenant_id,
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

  /** Loads a SharePoint manifest, naming the replica in the error when the lookup ran there. */
  private async require_sharepoint_manifest(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
    location?: 'source',
  ): Promise<SharePointSnapshotManifest> {
    const manifest = await this._sharepoint_manifests.find_by_snapshot(ctx, site_id, snapshot_id);
    if (!manifest) {
      const where = location === 'source' ? ' on source' : '';
      throw new Error(
        `No SharePoint manifest found for site ${site_id}, snapshot ${snapshot_id}${where}`,
      );
    }
    return manifest;
  }

  /** The primary bucket as a storage target. */
  private primary_target(): StorageTarget {
    return create_primary_target(this._target_factory, this._config);
  }
}
