import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { StatsUseCase } from '@atlas/types';
import type { BucketStats, MailboxStats } from '@atlas/types';
import { TENANT_CONTEXT_FACTORY_TOKEN, MANIFEST_REPOSITORY_TOKEN } from '@atlas/types';
import { aggregate_bucket_stats, aggregate_mailbox_stats } from '@/services/stats/stats-aggregator';
import { performance } from 'node:perf_hooks';

/** Runs `fn` and returns its result with `aggregation_us` injected. */
function timed<T>(fn: () => T): T & { aggregation_us: number } {
  const start = performance.now();
  const result = fn();
  const elapsed_us = Math.round((performance.now() - start) * 1000);
  return { ...result, aggregation_us: elapsed_us };
}

@injectable()
export class StatsService implements StatsUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /** Loads all manifests and computes bucket-wide statistics. */
  async get_bucket_stats(tenant_id: string): Promise<BucketStats> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const all = await this._manifests.list_all_manifests(ctx);
      return timed(() => aggregate_bucket_stats(tenant_id, all));
    } finally {
      ctx.destroy();
    }
  }

  /** Loads manifests for a single mailbox and computes its statistics. */
  async get_mailbox_stats(tenant_id: string, owner_id: string): Promise<MailboxStats> {
    owner_id = owner_id.toLowerCase();
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const all = await this._manifests.list_all_manifests(ctx);
      const filtered = all.filter((m) => m.owner_id === owner_id);
      return timed(() => aggregate_mailbox_stats(owner_id, filtered));
    } finally {
      ctx.destroy();
    }
  }
}
