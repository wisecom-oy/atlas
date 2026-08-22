import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
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
import type { Manifest } from '@wisecom/atlas-types';
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
  copy_outlook_snapshot_to_target,
  copy_outlook_snapshot_between,
  type CopyDeps,
} from '@/services/replication/outlook-snapshot-copier';
import { rehydrate_manifests } from '@/services/replication/rehydration-manifests-runner';
import {
  save_replication_status,
  list_all_replication_status,
  list_replication_status_by_owner,
  list_replication_status_by_snapshot,
} from '@/services/replication/replication-status-repository';
import {
  require_outlook_manifest,
  list_mailbox_manifests,
  diff_outlook_manifests,
} from '@/services/replication/outlook-replication-helpers';
import { ensure_source_dek_on_primary } from '@/services/replication/rehydration-dek-helper';
import {
  build_skip_result,
  to_status_record,
  merge_replication_results,
} from '@/services/replication/replication-result-builder';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';

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
  ) {}

  async replicate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const source_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const drive = await replicate_drive_snapshot(source_ctx, tenant_id, snapshot_id, targets, {
        onedrive: this._onedrive,
        sharepoint: this._sharepoint,
      });
      if (drive !== undefined) return drive;

      const manifest = await require_outlook_manifest(this._manifests, source_ctx, snapshot_id);
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const result = await this.copy_to_target(source_ctx, target, manifest, tenant_id);
        await save_replication_status(source_ctx, to_status_record(result, target, manifest));
        results.push(result);
      }

      return results;
    } finally {
      source_ctx.destroy();
    }
  }

  async replicate_mailbox(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    owner_id = normalize_owner_id(owner_id);
    const source_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifests = await list_mailbox_manifests(this._manifests, source_ctx, owner_id);
      const results: ReplicationResult[] = [];

      for (const target of targets) {
        const target_ctx = await target.create_context(tenant_id);
        try {
          const missing = await diff_outlook_manifests(manifests, target_ctx, owner_id);

          for (const manifest of missing) {
            const result = await this.copy_to_target(source_ctx, target, manifest, tenant_id);
            await save_replication_status(source_ctx, to_status_record(result, target, manifest));
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

  async rehydrate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const drive = await rehydrate_drive_snapshot(source_ctx, tenant_id, snapshot_id, source, {
        onedrive: this._onedrive,
        sharepoint: this._sharepoint,
      });
      if (drive !== undefined) return drive;

      const manifest = await require_outlook_manifest(
        this._manifests,
        source_ctx,
        snapshot_id,
        'source',
      );

      const manifest_key = `manifests/${manifest.owner_id}/${snapshot_id}.json`;
      if (await primary_ctx.storage.exists(manifest_key)) {
        return build_skip_result(snapshot_id, source.target_id);
      }

      return await this.copy_between(
        source_ctx,
        primary_ctx,
        manifest,
        source.target_id,
        tenant_id,
        true,
      );
    } finally {
      source_ctx.destroy();
      primary_ctx.destroy();
    }
  }

  async rehydrate_mailbox(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    owner_id = normalize_owner_id(owner_id);
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const manifests = await list_mailbox_manifests(this._manifests, source_ctx, owner_id);
      return await rehydrate_manifests(
        source_ctx,
        primary_ctx,
        manifests,
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

  /**
   * DR: recover every workload from a replica.
   *
   * Outlook manifests live under `manifests/`, OneDrive under `onedrive/manifests/` and SharePoint
   * under `sharepoint/manifests/`, so enumerating one prefix recovers one third of the tenant.
   * Each workload's own tenant-wide recovery is invoked and reported separately.
   */
  async rehydrate_tenant(
    tenant_id: string,
    source: StorageTarget,
  ): Promise<TenantRehydrationResult> {
    const outlook = await this.rehydrate_outlook_tenant(tenant_id, source);
    const onedrive = await this._onedrive.rehydrate_all_owners(tenant_id, source);
    const sharepoint = await this._sharepoint.rehydrate_all_sites(tenant_id, source);

    const workloads: WorkloadRehydrationResult[] = [
      { workload: 'outlook', result: outlook },
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
    };
  }

  private async rehydrate_outlook_tenant(
    tenant_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    try {
      const all_manifests = await this._manifests.list_all_manifests(source_ctx);
      return await rehydrate_manifests(
        source_ctx,
        primary_ctx,
        all_manifests,
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

  async get_replication_status(
    tenant_id: string,
    snapshot_id?: string,
  ): Promise<ReplicationStatusRecord[]> {
    const ctx = await this._tenant_factory.create(tenant_id);
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
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      return await list_replication_status_by_owner(ctx, owner_id);
    } finally {
      ctx.destroy();
    }
  }

  private async copy_to_target(
    source_ctx: TenantContext,
    target: StorageTarget,
    manifest: Manifest,
    tenant_id: string,
  ): Promise<ReplicationResult> {
    return await copy_outlook_snapshot_to_target(
      source_ctx,
      target,
      manifest,
      this.copy_deps(tenant_id),
    );
  }

  private async copy_between(
    source_ctx: TenantContext,
    target_ctx: TenantContext,
    manifest: Manifest,
    target_id: string,
    tenant_id: string,
    is_rehydration = false,
  ): Promise<ReplicationResult> {
    return await copy_outlook_snapshot_between(
      source_ctx,
      target_ctx,
      manifest,
      target_id,
      this.copy_deps(tenant_id),
      is_rehydration,
    );
  }

  private copy_deps(tenant_id: string): CopyDeps {
    return {
      validate_dek: this._validate_dek,
      passphrase: this._config.encryption_passphrase,
      tenant_id,
    };
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
