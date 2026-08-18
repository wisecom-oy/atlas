import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type {
  ManifestRepository,
  OneDriveManifestRepository,
  SharePointManifestRepository,
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import type { StatsUseCase } from '@wisecom/atlas-types';
import type { BucketStats, MailboxStats, DriveStats } from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import { aggregate_bucket_stats, aggregate_mailbox_stats } from '@/services/stats/stats-aggregator';
import {
  aggregate_drive_stats,
  type DriveManifestSummary,
} from '@/services/stats/drive-stats-aggregator';
import { performance } from 'node:perf_hooks';

/** Runs `fn` and returns its result with `aggregation_us` injected. */
function timed<T>(fn: () => T): T & { aggregation_us: number } {
  const start = performance.now();
  const result = fn();
  const elapsed_us = Math.round((performance.now() - start) * 1000);
  return { ...result, aggregation_us: elapsed_us };
}

/** Maps a OneDrive manifest to the service-agnostic aggregation shape. */
function to_onedrive_summary(manifest: OneDriveSnapshotManifest): DriveManifestSummary {
  return {
    owner_id: manifest.owner_id,
    owner_label: manifest.owner_email ?? manifest.owner_display_name,
    created_at: manifest.created_at,
    total_files: manifest.total_files,
    total_size_bytes: manifest.total_size_bytes,
  };
}

/** Maps a SharePoint manifest to the service-agnostic aggregation shape. */
function to_sharepoint_summary(manifest: SharePointSnapshotManifest): DriveManifestSummary {
  return {
    owner_id: manifest.site_id,
    owner_label: manifest.site_display_name ?? manifest.site_url,
    created_at: manifest.created_at,
    total_files: manifest.total_files,
    total_size_bytes: manifest.total_size_bytes,
  };
}

@injectable()
export class StatsService implements StatsUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _od_manifests: OneDriveManifestRepository,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _sp_manifests: SharePointManifestRepository,
  ) {}

  /** Loads all manifests and computes bucket-wide statistics. */
  async get_bucket_stats(tenant_id: string): Promise<BucketStats> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const all = await this._manifests.list_all_manifests(ctx);
      return timed(() => aggregate_bucket_stats(tenant_id, all));
    } finally {
      ctx.destroy();
    }
  }

  /** Loads manifests for a single mailbox and computes its statistics. */
  async get_mailbox_stats(tenant_id: string, owner_id: string): Promise<MailboxStats> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const all = await this._manifests.list_all_manifests(ctx);
      const filtered = all.filter((m) => m.owner_id === owner_id);
      return timed(() => aggregate_mailbox_stats(owner_id, filtered));
    } finally {
      ctx.destroy();
    }
  }

  /** Loads OneDrive manifests (all owners or one) and computes drive statistics. */
  async get_onedrive_stats(tenant_id: string, owner_id?: string): Promise<DriveStats> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifests = owner_id
        ? await this._od_manifests.list_snapshots_by_owner(ctx, owner_id)
        : await this._od_manifests.list_all_manifests(ctx);
      const summaries = manifests.map(to_onedrive_summary);
      return timed(() => aggregate_drive_stats(tenant_id, 'onedrive', summaries));
    } finally {
      ctx.destroy();
    }
  }

  /** Loads SharePoint manifests (all sites or one) and computes drive statistics. */
  async get_sharepoint_stats(tenant_id: string, site_id?: string): Promise<DriveStats> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifests = site_id
        ? await this._sp_manifests.list_snapshots_by_site(ctx, site_id)
        : await this._sp_manifests.list_all_manifests(ctx);
      const summaries = manifests.map(to_sharepoint_summary);
      return timed(() => aggregate_drive_stats(tenant_id, 'sharepoint', summaries));
    } finally {
      ctx.destroy();
    }
  }
}
