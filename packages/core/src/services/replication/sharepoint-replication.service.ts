import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import {
  copy_sharepoint_snapshot_between,
  copy_sharepoint_snapshot_into_context,
  copy_sharepoint_snapshot_to_target,
} from '@/services/replication/sharepoint-snapshot-copier';
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
import { rehydrate_sp_manifests } from '@/services/replication/rehydration-sp-manifests-runner';
import {
  build_skip_result,
  merge_replication_results,
} from '@/services/replication/replication-result-builder';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

import {
  SP_MANIFEST_PREFIX,
  to_sharepoint_status_record,
  collect_sp_ancillary_keys,
  diff_sp_manifests,
} from '@/services/replication/sharepoint-replication-result';

@injectable()
export class SharePointReplicationService implements SharePointReplicationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _sp_manifests: SharePointManifestRepository,
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
      const manifest = await this.require_sp_manifest(source_ctx, site_id, snapshot_id);
      const ancillary = await collect_sp_ancillary_keys(source_ctx, site_id);
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const result = await copy_sharepoint_snapshot_to_target(
          source_ctx,
          target,
          manifest,
          ancillary,
          this.copy_deps(tenant_id),
        );
        await save_replication_status(
          source_ctx,
          to_sharepoint_status_record(result, target, manifest),
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
      const manifests = await this._sp_manifests.list_snapshots_by_site(source_ctx, site_id);
      const ancillary = await collect_sp_ancillary_keys(source_ctx, site_id);
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
          const missing = await diff_sp_manifests(manifests, target_ctx, site_id);

          for (const manifest of missing) {
            const result = await copy_sharepoint_snapshot_into_context(
              source_ctx,
              target_ctx,
              manifest,
              ancillary,
              target.target_id,
            );
            await save_replication_status(
              source_ctx,
              to_sharepoint_status_record(result, target, manifest),
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
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifest = await this.require_sp_manifest_from_ctx(source_ctx, site_id, snapshot_id);
      const manifest_key = `${SP_MANIFEST_PREFIX}/${site_id}/${snapshot_id}.json`;

      if (await primary_ctx.storage.exists(manifest_key)) {
        return build_skip_result(snapshot_id, source.target_id, manifest.entries.length);
      }

      const ancillary = await collect_sp_ancillary_keys(source_ctx, site_id);
      return copy_sharepoint_snapshot_between(
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
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await this._sp_manifests.list_snapshots_by_site(source_ctx, site_id);
      const ancillary = await collect_sp_ancillary_keys(source_ctx, site_id);

      return rehydrate_sp_manifests(
        source_ctx,
        primary_ctx,
        manifests,
        ancillary,
        source,
        tenant_id,
        this._validate_dek,
        this._config.encryption_passphrase,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  /** DR: recover every SharePoint site's snapshots from a replica. */
  async rehydrate_all_sites(tenant_id: string, source: StorageTarget): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const all = await this._sp_manifests.list_all_manifests(source_ctx);
      const by_site = new Map<string, SharePointSnapshotManifest[]>();
      for (const manifest of all) {
        const bucket = by_site.get(manifest.site_id);
        if (bucket) bucket.push(manifest);
        else by_site.set(manifest.site_id, [manifest]);
      }

      const results: ReplicationResult[] = [];
      for (const [site_id, manifests] of by_site) {
        const ancillary = await collect_sp_ancillary_keys(source_ctx, site_id);
        results.push(
          await rehydrate_sp_manifests(
            source_ctx,
            primary_ctx,
            manifests,
            ancillary,
            source,
            tenant_id,
            this._validate_dek,
            this._config.encryption_passphrase,
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

  private async require_sp_manifest(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointSnapshotManifest> {
    const m = await this._sp_manifests.find_by_snapshot(ctx, site_id, snapshot_id);
    if (!m)
      throw new Error(`No SharePoint manifest found for site ${site_id}, snapshot ${snapshot_id}`);
    return m;
  }

  private async require_sp_manifest_from_ctx(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointSnapshotManifest> {
    const m = await this._sp_manifests.find_by_snapshot(ctx, site_id, snapshot_id);
    if (!m) {
      throw new Error(
        `No SharePoint manifest found for site ${site_id}, snapshot ${snapshot_id} on source`,
      );
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
