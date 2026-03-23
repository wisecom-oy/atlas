import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { StatsUseCase } from '@/ports/stats/use-case.port';
import type { BucketStats, MailboxStats } from '@/domain/stats';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
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
    const all = await this._manifests.list_all_manifests(ctx);
    return timed(() => aggregate_bucket_stats(tenant_id, all));
  }

  /** Loads manifests for a single mailbox and computes its statistics. */
  async get_mailbox_stats(tenant_id: string, mailbox_id: string): Promise<MailboxStats> {
    mailbox_id = mailbox_id.toLowerCase();
    const ctx = await this._tenant_factory.create(tenant_id);
    const all = await this._manifests.list_all_manifests(ctx);
    const filtered = all.filter((m) => m.mailbox_id === mailbox_id);
    return timed(() => aggregate_mailbox_stats(mailbox_id, filtered));
  }
}
