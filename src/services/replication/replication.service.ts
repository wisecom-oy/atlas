import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { ReplicationUseCase } from '@/ports/replication/use-case.port';
import type { StorageTarget, StorageTargetFactory } from '@/ports/replication/storage-target.port';
import type { DekValidationFn } from '@/ports/replication/dek-validation.port';
import type { ReplicationResult, ReplicationStatusRecord } from '@/domain/replication';
import type { Manifest } from '@/domain/manifest';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import {
  save_replication_status,
  list_all_replication_status,
  list_replication_status_by_mailbox,
  list_replication_status_by_snapshot,
} from '@/services/replication/replication-status-repository';
import { ensure_source_dek_on_primary } from '@/services/replication/rehydration-dek-helper';
import {
  build_replication_result,
  build_skip_result,
  to_status_record,
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
  ) {}

  async replicate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const source_ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this.require_manifest(source_ctx, snapshot_id);
    const results: ReplicationResult[] = [];

    for (const target of targets) {
      const result = await this.copy_to_target(source_ctx, target, manifest, tenant_id);
      await save_replication_status(source_ctx, to_status_record(result, target, manifest));
      results.push(result);
    }

    return results;
  }

  async replicate_mailbox(
    tenant_id: string,
    mailbox_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const source_ctx = await this._tenant_factory.create(tenant_id);
    const manifests = await this.list_mailbox_manifests(source_ctx, mailbox_id);
    const results: ReplicationResult[] = [];

    for (const target of targets) {
      const target_ctx = await target.create_context(tenant_id);
      const missing = await this.diff_manifests(manifests, target_ctx, mailbox_id);

      for (const manifest of missing) {
        const result = await this.copy_to_target(source_ctx, target, manifest, tenant_id);
        await save_replication_status(source_ctx, to_status_record(result, target, manifest));
        results.push(result);
      }
    }

    return results;
  }

  async rehydrate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    const manifest = await this.require_manifest_from_ctx(source_ctx, snapshot_id);

    const manifest_key = `manifests/${manifest.mailbox_id}/${snapshot_id}.json`;
    if (await primary_ctx.storage.exists(manifest_key)) {
      return build_skip_result(snapshot_id, source.target_id);
    }

    return this.copy_between(source_ctx, primary_ctx, manifest, source.target_id, tenant_id, true);
  }

  async rehydrate_mailbox(
    tenant_id: string,
    mailbox_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    const manifests = await this.list_mailbox_manifests(source_ctx, mailbox_id);

    return this.rehydrate_manifests(source_ctx, primary_ctx, manifests, source, tenant_id);
  }

  async rehydrate_tenant(tenant_id: string, source: StorageTarget): Promise<ReplicationResult> {
    await ensure_source_dek_on_primary(this.create_primary_target(), source, tenant_id);
    const primary_ctx = await this._tenant_factory.create(tenant_id);
    const source_ctx = await source.create_context(tenant_id);
    const all_manifests = await this._manifests.list_all_manifests(source_ctx);

    return this.rehydrate_manifests(source_ctx, primary_ctx, all_manifests, source, tenant_id);
  }

  async get_replication_status(
    tenant_id: string,
    snapshot_id?: string,
  ): Promise<ReplicationStatusRecord[]> {
    const ctx = await this._tenant_factory.create(tenant_id);
    if (snapshot_id) return list_replication_status_by_snapshot(ctx, snapshot_id);
    return list_all_replication_status(ctx);
  }

  async get_replication_status_by_mailbox(
    tenant_id: string,
    mailbox_id: string,
  ): Promise<ReplicationStatusRecord[]> {
    const ctx = await this._tenant_factory.create(tenant_id);
    return list_replication_status_by_mailbox(ctx, mailbox_id);
  }

  private async copy_to_target(
    source_ctx: TenantContext,
    target: StorageTarget,
    manifest: Manifest,
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
    const rep = await replicate_snapshot_to_target(source_ctx, target_ctx, manifest);
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
    manifest: Manifest,
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
    const rep = await replicate_snapshot_to_target(source_ctx, target_ctx, manifest, {
      skip_marker: is_rehydration,
    });
    return build_replication_result(rep, manifest.snapshot_id, target_id, Date.now() - start);
  }

  private async rehydrate_manifests(
    source_ctx: TenantContext,
    primary_ctx: TenantContext,
    manifests: Manifest[],
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
      const key = `manifests/${manifest.mailbox_id}/${manifest.snapshot_id}.json`;
      if (await primary_ctx.storage.exists(key)) {
        total_skipped++;
        continue;
      }

      const rep = await replicate_snapshot_to_target(source_ctx, primary_ctx, manifest, {
        skip_marker: true,
      });

      total_copied += rep.objects_copied;
      total_skipped += rep.objects_skipped;
      total_failed += rep.objects_failed;
      total_bytes += rep.bytes_copied;
      all_errors.push(...rep.errors);
      snapshot_count++;
    }

    const snapshot_label =
      manifests.length === 1 ? manifests[0]!.snapshot_id : `${snapshot_count}-snapshots`;

    return build_replication_result(
      {
        objects_copied: total_copied,
        objects_skipped: total_skipped,
        objects_failed: total_failed,
        bytes_copied: total_bytes,
        errors: all_errors,
      },
      snapshot_label,
      source.target_id,
      Date.now() - start,
    );
  }

  private async require_manifest(ctx: TenantContext, snapshot_id: string): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    return manifest;
  }

  private async require_manifest_from_ctx(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) throw new Error(`No manifest found for snapshot ${snapshot_id} on source`);
    return manifest;
  }

  private async list_mailbox_manifests(
    ctx: TenantContext,
    mailbox_id: string,
  ): Promise<Manifest[]> {
    const all = await this._manifests.list_all_manifests(ctx);
    return all
      .filter((m) => m.mailbox_id === mailbox_id)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  private async diff_manifests(
    source_manifests: Manifest[],
    target_ctx: TenantContext,
    mailbox_id: string,
  ): Promise<Manifest[]> {
    const target_keys = await target_ctx.storage.list(`manifests/${mailbox_id}/`);
    const target_snapshot_ids = new Set(
      target_keys.map((k) => k.split('/').pop()?.replace('.json', '')).filter(Boolean) as string[],
    );
    return source_manifests.filter((m) => !target_snapshot_ids.has(m.snapshot_id));
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
