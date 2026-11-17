import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type {
  ManifestRepository,
  OneDriveManifestRepository,
  SharePointManifestRepository,
  OneDriveSnapshotSummary,
  SharePointSnapshotSummary,
} from '@wisecom/atlas-types';
import type { StatsUseCase } from '@wisecom/atlas-types';
import type { BucketStats, MailboxStats, DriveStats } from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  aggregate_bucket_stats_from_summaries,
  aggregate_mailbox_stats_from_summaries,
} from '@/services/stats/stats-summary-aggregator';
import { require_every_summary } from '@/services/stats/require-every-summary';
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

/** Maps a OneDrive snapshot summary to the service-agnostic aggregation shape. */
function to_onedrive_summary(manifest: OneDriveSnapshotSummary): DriveManifestSummary {
  return {
    owner_id: manifest.owner_id,
    owner_label: manifest.owner_email ?? manifest.owner_display_name,
    created_at: manifest.created_at,
    total_files: manifest.total_files,
    total_size_bytes: manifest.total_size_bytes,
  };
}

/** Maps a SharePoint snapshot summary to the service-agnostic aggregation shape. */
function to_sharepoint_summary(manifest: SharePointSnapshotSummary): DriveManifestSummary {
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

  /** Reads every mailbox's snapshot summaries and computes bucket-wide statistics (#726). */
  async get_bucket_stats(tenant_id: string): Promise<BucketStats> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_all_snapshot_summaries(ctx);
      const summaries = require_every_summary(listing, 'Outlook');
      return timed(() => aggregate_bucket_stats_from_summaries(tenant_id, summaries));
    } finally {
      ctx.destroy();
    }
  }

  /** Reads one mailbox's snapshot summaries and computes its statistics (#726). */
  async get_mailbox_stats(tenant_id: string, owner_id: string): Promise<MailboxStats> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_snapshot_summaries(ctx, owner_id);
      const summaries = require_every_summary(listing, 'Outlook');
      return timed(() => aggregate_mailbox_stats_from_summaries(owner_id, summaries));
    } finally {
      ctx.destroy();
    }
  }

  /** Reads OneDrive snapshot summaries (all owners or one) and computes drive statistics. */
  async get_onedrive_stats(tenant_id: string, owner_id?: string): Promise<DriveStats> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = owner_id
        ? await this._od_manifests.list_snapshot_summaries(ctx, owner_id)
        : await this._od_manifests.list_all_snapshot_summaries(ctx);
      const summaries = require_every_summary(listing, 'OneDrive').map(to_onedrive_summary);
      return timed(() => aggregate_drive_stats(tenant_id, 'onedrive', summaries));
    } finally {
      ctx.destroy();
    }
  }

  /** Reads SharePoint snapshot summaries (all sites or one) and computes drive statistics. */
  async get_sharepoint_stats(tenant_id: string, site_id?: string): Promise<DriveStats> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = site_id
        ? await this._sp_manifests.list_snapshot_summaries(ctx, site_id)
        : await this._sp_manifests.list_all_snapshot_summaries(ctx);
      const summaries = require_every_summary(listing, 'SharePoint').map(to_sharepoint_summary);
      return timed(() => aggregate_drive_stats(tenant_id, 'sharepoint', summaries));
    } finally {
      ctx.destroy();
    }
  }
}
